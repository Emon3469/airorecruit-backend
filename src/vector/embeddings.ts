import path from 'node:path';
import { logger } from '../lib/logger';

/**
 * On-device sentence embeddings (all-MiniLM-L6-v2, 384 dims, quantized ONNX via transformers.js).
 * No API key, no per-call cost, no rate limit, and candidate data never leaves the machine.
 * The model (~23 MB) is downloaded once into ./.cache/models.
 */
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export type Embedder = (texts: string[]) => Promise<number[][]>;

let custom: Embedder | null = null;
/** Tests inject a deterministic embedder so they never download a model. */
export function setEmbedder(fn: Embedder | null) {
  custom = fn;
}

type Extractor = (input: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

async function loadExtractor(): Promise<Extractor> {
  // transformers.js is ESM-only; a native dynamic import keeps this CommonJS build working.
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<typeof import('@huggingface/transformers')>;
  const t = await dynamicImport('@huggingface/transformers');
  t.env.cacheDir = path.join(process.cwd(), '.cache', 'models');
  t.env.allowRemoteModels = true;
  const started = Date.now();
  const pipe = await t.pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
  logger.info({ model: EMBEDDING_MODEL, ms: Date.now() - started }, 'embedding model loaded');
  return pipe as unknown as Extractor;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (custom) return custom(texts);
  extractor ??= loadExtractor().catch((err) => {
    extractor = null;
    throw err;
  });
  const fn = await extractor;
  const out = await fn(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
