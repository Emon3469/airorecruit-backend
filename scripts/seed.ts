/**
 * npm run seed [-- --reset]
 *
 * Creates a ready-to-demo conversation:
 *   1. the sample JD posted as the recruiter's message
 *   2. the job extracted and created (seed acts as the recruiter confirming)
 *   3. seed/candidates.csv uploaded and attached to a PENDING sourcing proposal
 * The import itself still waits for you to click Confirm in the UI: the seed does not
 * bypass the human-in-the-loop gate for the pipeline.
 *
 * --reset drops the database first.
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../src/lib/db';
import { env } from '../src/config/env';
import { appendMessage, createConversation, setActiveJob } from '../src/services/chat.service';
import { extractJobDraft, createJob } from '../src/services/job.service';
import { storeCsvUpload, buildSearchQuery } from '../src/services/sourcing.service';
import { createProposal } from '../src/services/proposals';
import { logActivity } from '../src/services/activity.service';
import { closeRedis } from '../src/lib/redis';

async function main() {
  await connectDb();
  if (process.argv.includes('--reset')) {
    await mongoose.connection.db!.dropDatabase();
    await connectDb(); // re-sync indexes
    console.log('Database reset.');
  }
  const root = path.join(__dirname, '..', 'seed');
  const jd = fs.readFileSync(path.join(root, 'sample-jd.txt'), 'utf8');
  const csv = fs.readFileSync(path.join(root, 'candidates.csv'), 'utf8');

  const conv = await createConversation();
  await appendMessage(conv._id, { role: 'user', content: jd });
  const draft = await extractJobDraft(jd, { conversationId: conv._id });
  const job = await createJob({ draft, rawJD: jd, sourceUrl: null }, conv._id);
  await setActiveJob(conv._id, job._id, job.title);
  await logActivity({ jobId: job._id, actor: 'system', action: 'job_created', message: `Job "${job.title}" created by seed script` });
  await appendMessage(conv._id, {
    role: 'assistant',
    jobId: job._id,
    content: `(Seed) Job "${job.title}" created with ${draft.mustHaveSkills.length} must-have skills.`,
    cards: [{ type: 'ACTION_RESULT', payload: { kind: 'job_created', jobId: String(job._id), title: job.title } }],
  });

  const { upload, parsed } = await storeCsvUpload(String(job._id), 'candidates.csv', csv);
  await createProposal({
    conversationId: conv._id,
    jobId: job._id,
    type: 'START_SOURCING',
    proposedBy: 'system',
    payload: {
      jobId: String(job._id),
      useWebSearch: !!env.SERPER_API_KEY,
      query: buildSearchQuery(job),
      maxResults: env.SERPER_MAX_RESULTS,
      csvUploadIds: [String(upload._id)],
    },
    display: { jobTitle: job.title, webSearchAvailable: !!env.SERPER_API_KEY, uploads: [{ id: String(upload._id), filename: 'candidates.csv', rows: parsed.rows.length }] },
    message: `I attached seed/candidates.csv (${parsed.rows.length} valid rows, ${parsed.invalid.length} invalid). Confirm to start sourcing: ${env.SERPER_API_KEY ? 'web search plus ' : ''}CSV import, dedupe and scoring run in the background.`,
  });

  console.log(`\nSeeded.\n  conversationId: ${String(conv._id)}\n  jobId:          ${String(job._id)}\n  CSV rows:       ${parsed.rows.length} valid, ${parsed.invalid.length} invalid\nOpen the frontend and confirm the sourcing card.`);
  await mongoose.disconnect();
  await closeRedis();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
