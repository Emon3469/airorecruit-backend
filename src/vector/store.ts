import mongoose, { Schema } from 'mongoose';
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { EMBEDDING_DIM, EMBEDDING_MODEL, cosine } from './embeddings';

/**
 * Vector store for talent rediscovery.
 *  - QdrantStore: used when QDRANT_URL / QDRANT_CLUSTER_ENDPOINT is configured (cosine, payload-filtered).
 *  - MongoStore:  zero-infra fallback (vectors in a Mongo collection, brute-force cosine). Fine for
 *                 tens of thousands of candidates; Qdrant takes over beyond that.
 * Payloads carry only ids, never PII.
 */
export interface VectorPoint {
  candidateId: string;
  jobId: string;
  vector: number[];
  textHash: string;
}
export interface VectorHit {
  candidateId: string;
  jobId: string;
  score: number;
}
export interface VectorStore {
  readonly kind: 'qdrant' | 'mongo';
  upsert(points: VectorPoint[]): Promise<void>;
  search(vector: number[], opts: { limit: number; excludeJobId?: string }): Promise<VectorHit[]>;
  hashes(candidateIds: string[]): Promise<Map<string, string>>;
  remove(candidateIds: string[]): Promise<void>;
  count(): Promise<number>;
}

/* ------------------------------------------------------------------ Mongo fallback */
const EmbeddingSchema = new Schema(
  {
    candidateId: { type: String, required: true, unique: true },
    jobId: { type: String, required: true, index: true },
    vector: { type: [Number], required: true },
    textHash: { type: String, required: true },
    model: { type: String, default: EMBEDDING_MODEL },
  },
  { timestamps: true, versionKey: false },
);
export const CandidateEmbedding = mongoose.models.CandidateEmbedding ?? mongoose.model('CandidateEmbedding', EmbeddingSchema);

class MongoStore implements VectorStore {
  readonly kind = 'mongo' as const;
  async upsert(points: VectorPoint[]) {
    if (!points.length) return;
    await CandidateEmbedding.bulkWrite(
      points.map((p) => ({ updateOne: { filter: { candidateId: p.candidateId }, update: { $set: { ...p, model: EMBEDDING_MODEL } }, upsert: true } })),
    );
  }
  async search(vector: number[], opts: { limit: number; excludeJobId?: string }) {
    const docs = await CandidateEmbedding.find(opts.excludeJobId ? { jobId: { $ne: opts.excludeJobId } } : {}, { candidateId: 1, jobId: 1, vector: 1 })
      .limit(50_000)
      .lean<{ candidateId: string; jobId: string; vector: number[] }[]>();
    return docs
      .map((d) => ({ candidateId: d.candidateId, jobId: d.jobId, score: cosine(vector, d.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }
  async hashes(ids: string[]) {
    const docs = await CandidateEmbedding.find({ candidateId: { $in: ids } }, { candidateId: 1, textHash: 1 }).lean<{ candidateId: string; textHash: string }[]>();
    return new Map(docs.map((d) => [d.candidateId, d.textHash]));
  }
  async remove(ids: string[]) {
    await CandidateEmbedding.deleteMany({ candidateId: { $in: ids } });
  }
  async count() {
    return CandidateEmbedding.countDocuments();
  }
}

/* ------------------------------------------------------------------ Qdrant */
/** Qdrant point ids must be UUIDs or integers; a 24-hex ObjectId maps 1:1 to a UUID. */
export const toUuid = (oid: string) => {
  const h = `${oid}00000000`.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

class QdrantStore implements VectorStore {
  readonly kind = 'qdrant' as const;
  private client: QdrantClient;
  private ready: Promise<void> | null = null;
  constructor(url: string, apiKey: string | undefined, private readonly collection: string) {
    this.client = new QdrantClient({ url, apiKey, checkCompatibility: false, timeout: 15_000 });
  }
  private ensure() {
    this.ready ??= (async () => {
      const exists = await this.client.collectionExists(this.collection);
      if (!exists.exists) {
        await this.client.createCollection(this.collection, { vectors: { size: EMBEDDING_DIM, distance: 'Cosine' } });
        await this.client.createPayloadIndex(this.collection, { field_name: 'jobId', field_schema: 'keyword' });
        logger.info({ collection: this.collection }, 'qdrant collection created');
      }
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }
  async upsert(points: VectorPoint[]) {
    if (!points.length) return;
    await this.ensure();
    await this.client.upsert(this.collection, {
      wait: true,
      points: points.map((p) => ({ id: toUuid(p.candidateId), vector: p.vector, payload: { candidateId: p.candidateId, jobId: p.jobId, textHash: p.textHash } })),
    });
  }
  async search(vector: number[], opts: { limit: number; excludeJobId?: string }) {
    await this.ensure();
    const res = await this.client.search(this.collection, {
      vector,
      limit: opts.limit,
      with_payload: true,
      ...(opts.excludeJobId ? { filter: { must_not: [{ key: 'jobId', match: { value: opts.excludeJobId } }] } } : {}),
    });
    return res.map((r) => ({ candidateId: String(r.payload?.candidateId), jobId: String(r.payload?.jobId), score: r.score }));
  }
  async hashes(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    await this.ensure();
    const pts = await this.client.retrieve(this.collection, { ids: ids.map(toUuid), with_payload: true, with_vector: false });
    return new Map(pts.map((p) => [String(p.payload?.candidateId), String(p.payload?.textHash)]));
  }
  async remove(ids: string[]) {
    if (!ids.length) return;
    await this.ensure();
    await this.client.delete(this.collection, { wait: true, points: ids.map(toUuid) });
  }
  async count() {
    await this.ensure();
    return (await this.client.count(this.collection, { exact: true })).count;
  }
}

let store: VectorStore | null = null;
let override: VectorStore | null = null;

export function setVectorStore(s: VectorStore | null) {
  override = s;
}

export function vectorStore(): VectorStore {
  if (override) return override;
  if (!store) store = env.qdrantUrl ? new QdrantStore(env.qdrantUrl, env.QDRANT_API_KEY, env.QDRANT_COLLECTION) : new MongoStore();
  return store;
}

export function mongoVectorStore(): VectorStore {
  return new MongoStore();
}
