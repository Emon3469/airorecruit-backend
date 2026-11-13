import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { getStack, seedJob } from '../../evals/lib/stack';
import { createApp } from '../../src/app';
import { handleUserMessage } from '../../src/agent/agent';
import { confirmAction } from '../../src/services/actions.service';
import { searchTalentPool } from '../../src/services/talent.service';
import { Candidate, Job, PendingAction, SourcingRun } from '../../src/models';
import { CandidateEmbedding } from '../../src/vector/store';

const app = createApp();
let stack: Awaited<ReturnType<typeof getStack>>;
let jobA: string;

beforeAll(async () => {
  stack = await getStack();
  ({ jobId: jobA } = await seedJob()); // 13 scored candidates, indexed by the scoring worker
});
afterAll(async () => stack?.stop());

describe('talent rediscovery (vector search over earlier jobs)', () => {
  it('scoring indexes every candidate (ids only in the payload, no PII)', async () => {
    expect(await CandidateEmbedding.countDocuments({ jobId: jobA })).toBe(13);
    const doc = await CandidateEmbedding.findOne({ jobId: jobA }).lean<{ vector: number[] } & Record<string, unknown>>();
    expect(Object.keys(doc!).sort()).toEqual(expect.arrayContaining(['candidateId', 'jobId', 'vector', 'textHash']));
    expect(JSON.stringify(doc)).not.toMatch(/@example\.com/);
  });

  it('a new job finds strong matches from the earlier job, never unsubscribed or hired people', async () => {
    const strong = await Candidate.findOne({ jobId: jobA, name: 'Farhana Islam' });
    await Candidate.updateOne({ _id: strong!._id }, { $set: { status: 'Unsubscribed', outreachStopped: true, outreachStoppedReason: 'unsubscribed' } });
    const jobB = await Job.create({ title: 'Lead Frontend Engineer', mustHaveSkills: ['React', 'TypeScript', 'Next.js'], niceToHaveSkills: ['Accessibility'], rawJD: 'Lead Frontend Engineer with React, TypeScript and Next.js', seniority: 'lead' });
    const matches = await searchTalentPool({ jobId: String(jobB._id), limit: 10 });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.fromJobId === jobA)).toBe(true);
    expect(matches.map((m) => m.name)).not.toContain('Farhana Islam'); // unsubscribed: never resurfaced
    expect(matches[0]!.similarity).toBeGreaterThanOrEqual(matches[matches.length - 1]!.similarity);
    const api = await request(app).get(`/api/jobs/${String(jobB._id)}/talent-pool?limit=5`);
    expect(api.status).toBe(200);
    expect(api.body.matches.length).toBeGreaterThan(0);
  });

  it('chat "anyone from previous jobs?" is read-only; the import happens only in a confirmed sourcing run', async () => {
    const { conversationId, jobId: jobC } = await seedJobWithoutCandidates();
    await handleUserMessage(conversationId, 'anyone from previous jobs who fits this role?');
    expect(await Candidate.countDocuments({ jobId: jobC })).toBe(0);

    await handleUserMessage(conversationId, 'start sourcing');
    const p = (await PendingAction.findOne({ conversationId, type: 'START_SOURCING', status: 'pending' }).sort({ createdAt: -1 }))!;
    expect((p.payload as { includeTalentPool: boolean }).includeTalentPool).toBe(true);
    expect(await Candidate.countDocuments({ jobId: jobC })).toBe(0); // still a proposal

    await confirmAction(String(p._id), 'user_ui', { useWebSearch: false });
    await stack.queue.drain('sourcing');
    await stack.queue.drain('scoring');
    const run = (await SourcingRun.findOne({ jobId: jobC }))!;
    expect(run.poolFound).toBeGreaterThan(0);
    const copies = await Candidate.find({ jobId: jobC });
    expect(copies.length).toBe(run.created);
    expect(copies.every((c) => c.source === 'talent_pool' && c.status === 'Sourced')).toBe(true);
    expect(copies.every((c) => c.scoringStatus === 'scored')).toBe(true); // re-scored against the new job
    expect(copies.every((c) => !c.email || c.emailSource === 'csv' || c.emailSource === 'manual')).toBe(true); // provenance kept
  });
});

async function seedJobWithoutCandidates() {
  const { createConversation, setActiveJob } = await import('../../src/services/chat.service');
  const conv = await createConversation();
  const job = await Job.create({
    conversationId: conv._id,
    title: 'Senior Frontend Engineer (Dashboard)',
    mustHaveSkills: ['React', 'TypeScript', 'Vitest'],
    niceToHaveSkills: ['TanStack Query'],
    rawJD: 'Senior Frontend Engineer, React, TypeScript, Vitest, TanStack Query',
    seniority: 'senior',
  });
  await setActiveJob(conv._id, job._id, job.title);
  return { conversationId: String(conv._id), jobId: String(job._id) };
}
