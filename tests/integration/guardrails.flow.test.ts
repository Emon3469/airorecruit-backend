import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { getStack, seedJob } from '../../evals/lib/stack';
import { createApp } from '../../src/app';
import { handleUserMessage } from '../../src/agent/agent';
import { confirmAction } from '../../src/services/actions.service';
import { applyDecisions } from '../../src/services/pipeline.service';
import { receiveReply } from '../../src/services/reply.service';
import { Candidate, ChatMessage, GuardrailEvent, PendingAction, Reply } from '../../src/models';

const app = createApp();
let jobId: string;
let convId: string;
let stack: Awaited<ReturnType<typeof getStack>>;

beforeAll(async () => {
  stack = await getStack();
  ({ jobId, conversationId: convId } = await seedJob());
});
afterAll(async () => stack?.stop());

describe('guardrails wired end to end', () => {
  it('blocked chat input is audited, never reaches the LLM, and secrets are not persisted', async () => {
    await handleUserMessage(convId, 'my key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(await ChatMessage.countDocuments({ conversationId: convId, content: /sk-proj-AbCd/ })).toBe(0);
    expect(await GuardrailEvent.countDocuments({ rail: 'secrets', verdict: 'block' })).toBe(1);
    const last = await ChatMessage.findOne({ conversationId: convId }).sort({ createdAt: -1 });
    expect(last?.cards[0]?.type).toBe('GUARDRAIL');
  });

  it('an edited campaign draft with an unfilled placeholder is blocked at commit and can be fixed', async () => {
    const ids = await Candidate.find({ jobId, name: { $in: ['Rahim Chowdhury', 'Nusrat Jahan'] } }, { _id: 1 });
    await applyDecisions(jobId, ids.map((c) => ({ candidateId: String(c._id), decision: 'accept' as const })), 'user_ui');
    await handleUserMessage(convId, 'create a campaign day 0, day 3');
    const p = (await PendingAction.findOne({ conversationId: convId, type: 'CREATE_CAMPAIGN', status: 'pending' }))!;
    const payload = p.payload as { recipients: { drafts: { stepNumber: number; subject: string; body: string }[] }[] };
    const broken = structuredClone(payload.recipients);
    broken[0]!.drafts[0]!.body = `Hi there, we'd love you at {{company}}. Interested? Best, {{senderName}}`;
    await expect(confirmAction(String(p._id), 'user_ui', { recipients: broken })).rejects.toThrow(/Guardrails blocked this campaign/);
    expect((await PendingAction.findById(p._id))!.status).toBe('pending'); // recoverable: card stays editable
    await expect(confirmAction(String(p._id), 'user_ui', { recipients: payload.recipients })).resolves.toBeTruthy();
  });

  it('time-sensitive replies are flagged high priority on the reply card', async () => {
    const outbound = stack.queue.pending('outreach');
    await stack.queue.drain('outreach'); // send step 1 so candidates are Contacted
    expect(outbound.length).toBeGreaterThan(0);
    const rahim = (await Candidate.findOne({ jobId, name: 'Rahim Chowdhury' }))!;
    await receiveReply({ candidateId: String(rahim._id), body: 'Interested! I have another offer that expires Friday, can we talk this week?' });
    await stack.queue.drain('replies');
    const reply = (await Reply.findOne({ candidateId: rahim._id }))!;
    expect(reply.priority).toBe('high');
    expect(reply.urgencySignals).toEqual(expect.arrayContaining(['competing offer', 'deadline']));
    const card = await ChatMessage.findOne({ conversationId: convId, 'cards.type': 'REPLY_REVIEW' }).sort({ createdAt: -1 });
    expect(card?.content).toMatch(/Time-sensitive/);
  });

  it('async turns: 202 immediately, one turn at a time per conversation, reply delivered later', async () => {
    const first = await request(app).post(`/api/conversations/${convId}/messages`).send({ content: 'how is the job going?', async: true });
    expect(first.status).toBe(202);
    expect(first.body.turnId).toBeTruthy();
    const second = await request(app).post(`/api/conversations/${convId}/messages`).send({ content: 'show me the candidates', async: true });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TURN_IN_PROGRESS');
    for (let i = 0; i < 50 && (await request(app).get(`/api/conversations/${convId}`)).body.turnInProgress; i++) await new Promise((r) => setTimeout(r, 100));
    const last = await ChatMessage.findOne({ conversationId: convId, role: 'assistant' }).sort({ createdAt: -1 });
    expect(last?.cards.some((c) => c.type === 'STATS_SUMMARY')).toBe(true);
  });

  it('ops metrics expose LLMOps, guardrail and HITL telemetry (no non-human confirmations)', async () => {
    const res = await request(app).get(`/api/ops/metrics?jobId=${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.hitl.nonHumanConfirmations).toBe(0);
    expect(res.body.hitl.proposals).toBeGreaterThan(0);
    expect(res.body.llm.some((l: { purpose: string }) => l.purpose === 'scoring')).toBe(true);
    expect(res.body.scoring.histogram.counts.reduce((a: number, b: number) => a + b, 0)).toBe(13);
    const ev = await request(app).get('/api/guardrails/events?rail=secrets');
    expect(ev.body.events).toHaveLength(1);
    const check = await request(app).post('/api/guardrails/check').send({ mode: 'email', subject: 'Hi', text: 'Hi {{company}} reply now please thanks' });
    expect(check.body.verdict).toBe('block');
  });
});
