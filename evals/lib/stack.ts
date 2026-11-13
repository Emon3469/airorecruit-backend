import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { startHarness, type MemoryQueue } from '../../tests/integration/harness';
import { createConversation, setActiveJob } from '../../src/services/chat.service';
import { createJob, extractJobDraft } from '../../src/services/job.service';
import { startSourcing, storeCsvUpload } from '../../src/services/sourcing.service';
import { Candidate, Job } from '../../src/models';

/**
 * Docker-free evaluation stack: in-memory MongoDB (mongodb-memory-server) + an in-memory queue
 * adapter that executes the REAL worker functions. Nothing is mocked except infrastructure;
 * the LLM is real when LLM_API_KEY is set, otherwise the deterministic offline provider.
 */
export const ROOT = path.join(__dirname, '..', '..');
export const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T;

let stack: Awaited<ReturnType<typeof startHarness>> | null = null;
export async function getStack(): Promise<{ queue: MemoryQueue; stop: () => Promise<void> }> {
  if (!stack) stack = await startHarness();
  return stack;
}

/** Create a job from the sample JD, import + dedupe + score the sample CSV (all through the real pipeline). */
export async function seedJob(): Promise<{ jobId: string; conversationId: string }> {
  const { queue } = await getStack();
  const jd = fs.readFileSync(path.join(ROOT, 'seed', 'sample-jd.txt'), 'utf8');
  const csv = fs.readFileSync(path.join(ROOT, 'seed', 'candidates.csv'), 'utf8');
  const conv = await createConversation();
  const draft = await extractJobDraft(jd, { conversationId: conv._id });
  const job = await createJob({ draft, rawJD: jd, sourceUrl: null }, conv._id);
  await setActiveJob(conv._id, job._id, job.title);
  const { upload } = await storeCsvUpload(String(job._id), 'candidates.csv', csv);
  await startSourcing({ jobId: String(job._id), useWebSearch: false, query: null, maxResults: 10, csvUploadIds: [String(upload._id)] }, conv._id);
  await queue.drain('sourcing');
  await queue.drain('scoring');
  return { jobId: String(job._id), conversationId: String(conv._id) };
}

/** Fingerprint of all business state; used to detect writes that happened without a confirmation. */
export async function stateFingerprint(jobId: string): Promise<string> {
  const [cands, job] = await Promise.all([
    Candidate.find({ jobId }, { status: 1, email: 1, outreachStopped: 1 }).sort({ _id: 1 }).lean(),
    Job.findById(jobId, { title: 1, settings: 1, status: 1 }).lean(),
  ]);
  const db = mongoose.connection.db!;
  const counts = await Promise.all(['campaigns', 'dispatchlogs', 'bookings', 'jobs'].map((c) => db.collection(c).countDocuments()));
  return JSON.stringify({ cands: cands.map((c) => [String(c._id), c.status, c.email, c.outreachStopped]), job, counts });
}
