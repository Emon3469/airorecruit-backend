/**
 * npm run talent:smoke
 * Verifies the real talent-rediscovery stack: on-device embeddings + Qdrant (if configured).
 * Uses a throwaway collection that is deleted at the end; credentials are never printed.
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../src/config/env';
import { EMBEDDING_DIM, cosine, embed } from '../src/vector/embeddings';
import { toUuid } from '../src/vector/store';

async function main() {
  const texts = [
    'Role: Senior Frontend Engineer. Skills: React, TypeScript, TanStack Query, Vitest. Experience: 7 years',
    'Role: Lead UI Engineer. Skills: React, Next.js, accessibility, design systems. Experience: 9 years',
    'Role: Backend Engineer. Skills: Go, PostgreSQL, Kubernetes, gRPC. Experience: 6 years',
  ];
  const job = 'Role: Senior React Engineer. Skills: React, TypeScript, Jest, Testing Library. Seniority: senior';
  let t = Date.now();
  const [j, ...cands] = await embed([job, ...texts]);
  console.log(`local embeddings: ${cands.length + 1} vectors, dim=${j!.length} (expected ${EMBEDDING_DIM}), ${Date.now() - t} ms (includes first-time model load)`);
  console.log('cosine(job, frontend)=%s  cosine(job, lead UI)=%s  cosine(job, backend Go)=%s', ...cands.map((c) => cosine(j!, c).toFixed(3)));

  if (!env.qdrantUrl) return console.log('Qdrant not configured: talent pool uses the MongoDB fallback store.');
  const client = new QdrantClient({ url: env.qdrantUrl, apiKey: env.QDRANT_API_KEY, checkCompatibility: false, timeout: 15_000 });
  const col = 'airorecruit_smoke';
  t = Date.now();
  try {
    if ((await client.collectionExists(col)).exists) await client.deleteCollection(col);
    await client.createCollection(col, { vectors: { size: EMBEDDING_DIM, distance: 'Cosine' } });
    const ids = ['64b000000000000000000001', '64b000000000000000000002', '64b000000000000000000003'];
    await client.upsert(col, { wait: true, points: cands.map((v, i) => ({ id: toUuid(ids[i]!), vector: v, payload: { candidateId: ids[i], jobId: 'job-a' } })) });
    const hits = await client.search(col, { vector: j!, limit: 3, with_payload: true });
    console.log(`qdrant OK (${Date.now() - t} ms): ranking =`, hits.map((h) => `${h.payload?.candidateId?.toString().slice(-1)}:${h.score.toFixed(3)}`).join(' > '));
  } finally {
    await client.deleteCollection(col).catch(() => undefined);
    console.log('throwaway collection removed');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('TALENT SMOKE FAILED:', (e as Error).message.slice(0, 400));
    process.exit(1);
  });
