import type { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { Campaign, Candidate, DispatchLog, Job, SendQuota, type CampaignDoc, type CandidateDoc, type JobDoc } from '../models';
import { ConflictError, NotFoundError, ValidationError, isDuplicateKeyError } from '../lib/errors';
import { logger } from '../lib/logger';
import { OUTREACH_BLOCKING } from '../domain/pipeline';
import { firstName } from '../domain/normalize';
import type { Actor } from '../domain/cards';
import { json } from '../llm';
import { OUTREACH_SYSTEM } from '../llm/prompts';
import { wrapUntrusted } from '../domain/untrusted';
import { logActivity } from './activity.service';
import { publish } from './events';
import { transition, maybeCompleteCampaign } from './pipeline.service';
import { enqueue, jobIds, promoteJob, QUEUE_NAMES } from '../queues/queues';
import { fillPlaceholders, sendEmail, senderName } from './mailer';
import { checkOutboundEmail } from '../guardrails/outbound';
import { recordFindings } from '../guardrails/engine';

/* ------------------------------------------------------------- Schemas */

export const StepSchema = z.object({
  stepNumber: z.number().int().min(0).max(9),
  delayDays: z.number().min(0).max(60),
  label: z.string().max(40).optional(),
});

const DraftSchema = z.object({
  stepNumber: z.number().int().min(0),
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(20).max(4000),
});

export const CampaignPayloadSchema = z
  .object({
    jobId: z.string(),
    name: z.string().trim().min(1).max(120),
    dailyLimit: z.number().int().min(1).max(1000),
    steps: z.array(StepSchema).min(1).max(5),
    recipients: z
      .array(
        z.object({
          candidateId: z.string(),
          name: z.string(),
          email: z.string().email(),
          drafts: z.array(DraftSchema).min(1),
        }),
      )
      .min(1, 'A campaign needs at least one eligible recipient'),
    excluded: z.array(z.object({ candidateId: z.string(), name: z.string(), reason: z.string() })).default([]),
  })
  .superRefine((p, ctx) => {
    const nums = p.steps.map((s) => s.stepNumber);
    if (nums.some((n, i) => n !== i)) ctx.addIssue({ code: 'custom', message: 'Steps must be numbered 0..n-1 in order' });
    if (p.steps[0]?.delayDays !== 0) ctx.addIssue({ code: 'custom', message: 'The first step must be sent on day 0' });
    for (let i = 1; i < p.steps.length; i++) {
      if (p.steps[i]!.delayDays <= p.steps[i - 1]!.delayDays)
        ctx.addIssue({ code: 'custom', message: 'Follow-up days must increase (e.g. 0, 3, 7)' });
    }
    for (const r of p.recipients) {
      for (const s of p.steps) {
        if (!r.drafts.some((d) => d.stepNumber === s.stepNumber))
          ctx.addIssue({ code: 'custom', message: `${r.name} is missing a draft for step ${s.stepNumber}` });
      }
    }
  });
export type CampaignPayload = z.infer<typeof CampaignPayloadSchema>;

const GeneratedDraftsSchema = z.object({
  emails: z.array(DraftSchema).min(1).max(5),
});

/* ------------------------------------------------------------- Eligibility */

export async function activeCampaignFor(candidateId: Types.ObjectId | string) {
  return Campaign.findOne({ status: { $ne: 'completed' }, recipients: { $elemMatch: { candidateId, state: 'active' } } });
}

export async function eligibility(c: CandidateDoc): Promise<string | null> {
  if (c.status !== 'Accepted') return `status is ${c.status}${c.status === 'Sourced' ? ' (accept them first)' : ''}`;
  if (!c.email) return 'no email address on file (add one via CSV upload or by editing the candidate)';
  if (c.outreachStopped) return `outreach stopped (${c.outreachStoppedReason ?? 'stopped'})`;
  if (await activeCampaignFor(c._id)) return 'already in an active campaign';
  return null;
}

/* ------------------------------------------------------------- Drafting */

function templateDrafts(job: { title: string; company?: string | null }, cand: CandidateDoc, steps: z.infer<typeof StepSchema>[]) {
  const fn = firstName(cand.name);
  const skills = cand.matchedSkills.slice(0, 2);
  const hook = skills.length ? `your experience with ${skills.join(' and ')}` : cand.headline ? `your background as ${cand.headline}` : 'your background';
  const org = job.company ? ` at ${job.company}` : '';
  return steps.map((s, i) => {
    if (i === 0)
      return {
        stepNumber: s.stepNumber,
        subject: `${job.title}${org}: would you be open to a chat?`,
        body: `Hi ${fn},\n\nI'm hiring for a ${job.title} role${org} and ${hook} stood out to me. I think it could be a strong fit.\n\nWould you be open to a short call this week to hear more? Just reply to this email.\n\nBest,\n{{senderName}}`,
      };
    if (i === steps.length - 1 && i > 1)
      return {
        stepNumber: s.stepNumber,
        subject: `Re: ${job.title}${org}`,
        body: `Hi ${fn},\n\nI'll close the loop here so I don't crowd your inbox. If the ${job.title} role is ever of interest, just reply and I'll share details.\n\nAll the best,\n{{senderName}}`,
      };
    return {
      stepNumber: s.stepNumber,
      subject: `Re: ${job.title}${org}`,
      body: `Hi ${fn},\n\nJust following up on my note about the ${job.title} role. Happy to share more details if helpful. A quick reply either way is appreciated.\n\nBest,\n{{senderName}}`,
    };
  });
}

async function draftFor(job: JobDoc, cand: CandidateDoc, steps: z.infer<typeof StepSchema>[], tone: string) {
  const known = [
    `Name: ${cand.name}`,
    cand.headline ? `Headline: ${cand.headline}` : null,
    cand.currentCompany ? `Current company: ${cand.currentCompany}` : null,
    cand.matchedSkills.length ? `Skills that match the job: ${cand.matchedSkills.join(', ')}` : null,
    cand.location ? `Location: ${cand.location}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const jobData = {
    title: job.title,
    company: job.company,
    location: job.location,
    remotePolicy: job.remotePolicy,
    mustHaveSkills: job.mustHaveSkills,
    summary: job.summary,
  };
  const out = await json(
    {
      tier: 'agent',
      system: OUTREACH_SYSTEM,
      prompt: `JOB DATA (trusted):\n${JSON.stringify(jobData)}\n\nSEQUENCE: ${steps.map((s) => `step ${s.stepNumber} on day ${s.delayDays}`).join(', ')}\nTONE: ${tone}\n\nWhat we know about the candidate:\n${wrapUntrusted(cand.source, known)}\n\nWrite one email per step (stepNumber must match). Greet them by first name (${firstName(cand.name)}).`,
      schema: GeneratedDraftsSchema,
      schemaName: 'outreach_drafts',
      effort: 'low',
      maxTokens: 4000,
      mock: () => ({ emails: templateDrafts(job, cand, steps) }),
    },
    { purpose: 'outreach_drafting', jobId: job._id },
  );
  // Guarantee coverage of every step even if the model skipped one: fall back to the template for that step.
  const template = templateDrafts(job, cand, steps);
  return steps.map((s) => out.emails.find((e) => e.stepNumber === s.stepNumber) ?? template.find((t) => t.stepNumber === s.stepNumber)!);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    }),
  );
  return results;
}

export interface BuildCampaignInput {
  jobId: string;
  candidateIds?: string[];
  steps?: { delayDays: number; label?: string }[];
  dailyLimit?: number;
  tone?: string;
  name?: string;
}

/** Build the CREATE_CAMPAIGN proposal: eligibility filter + personalised drafts. Writes nothing. */
export async function buildCampaignProposal(input: BuildCampaignInput): Promise<CampaignPayload> {
  const job = await Job.findById(input.jobId);
  if (!job) throw new NotFoundError('Job');
  const pool = input.candidateIds?.length
    ? await Candidate.find({ _id: { $in: input.candidateIds }, jobId: job._id })
    : await Candidate.find({ jobId: job._id, status: 'Accepted' }).sort({ score: -1 });

  const eligible: CandidateDoc[] = [];
  const excluded: CampaignPayload['excluded'] = [];
  for (const c of pool) {
    const why = await eligibility(c);
    if (why) excluded.push({ candidateId: String(c._id), name: c.name, reason: why });
    else eligible.push(c);
  }
  if (!input.candidateIds?.length) {
    // Also surface accepted-but-ineligible people the recruiter may expect to be included.
    const noEmail = await Candidate.find({ jobId: job._id, status: 'Accepted', email: null });
    for (const c of noEmail) if (!excluded.some((e) => e.candidateId === String(c._id))) excluded.push({ candidateId: String(c._id), name: c.name, reason: 'no email address on file' });
  }
  if (!eligible.length) {
    throw new ValidationError(
      `No eligible candidates for outreach. Only Accepted candidates with an email can be added.${excluded.length ? ` Excluded: ${excluded.slice(0, 8).map((e) => `${e.name} (${e.reason})`).join('; ')}.` : ''}`,
      { excluded },
    );
  }

  const rawSteps = input.steps?.length ? input.steps : [{ delayDays: 0 }, { delayDays: 3 }, { delayDays: 7 }];
  const sorted = [...rawSteps].sort((a, b) => a.delayDays - b.delayDays);
  const steps = sorted.map((s, i) => ({ stepNumber: i, delayDays: i === 0 ? 0 : s.delayDays, label: s.label ?? (i === 0 ? 'Intro' : `Follow-up ${i}`) }));

  const recipients = await mapLimit(eligible.slice(0, 100), 4, async (c) => ({
    candidateId: String(c._id),
    name: c.name,
    email: c.email!,
    drafts: await draftFor(job, c, steps, input.tone ?? 'warm, concise, professional'),
  }));

  return CampaignPayloadSchema.parse({
    jobId: String(job._id),
    name: input.name ?? `${job.title} outreach`,
    dailyLimit: Math.min(input.dailyLimit ?? env.DAILY_SEND_LIMIT, 1000),
    steps,
    recipients,
    excluded,
  });
}

/* ------------------------------------------------------------- Commit */

export async function commitCampaign(payload: CampaignPayload, conversationId: Types.ObjectId | string | null, actor: Actor) {
  const p = CampaignPayloadSchema.parse(payload);
  const job = await Job.findById(p.jobId);
  if (!job) throw new NotFoundError('Job');

  // Re-check eligibility at commit time: state may have changed since the proposal.
  const finalRecipients: CampaignPayload['recipients'] = [];
  const dropped: { name: string; reason: string }[] = [];
  for (const r of p.recipients) {
    const c = await Candidate.findOne({ _id: r.candidateId, jobId: job._id });
    const why = c ? await eligibility(c) : 'not found';
    if (why) dropped.push({ name: r.name, reason: why });
    else if (c!.email !== r.email.toLowerCase()) dropped.push({ name: r.name, reason: 'email changed since the preview; re-create the campaign' });
    else finalRecipients.push(r);
  }
  if (!finalRecipients.length) throw new ConflictError('NO_ELIGIBLE_RECIPIENTS', 'None of the recipients are eligible anymore.', { dropped });

  // Outbound rail at commit time (after any edits): a blocking finding stops the whole campaign.
  const blocked: { name: string; step: number; reason: string; matches?: string[] }[] = [];
  for (const r of finalRecipients) {
    for (const d of r.drafts) {
      const { findings } = checkOutboundEmail({ subject: d.subject, body: d.body, recipientEmail: r.email, job: { salaryRaw: job.salary?.raw, title: job.title, company: job.company } });
      for (const f of findings.filter((x) => x.verdict === 'block')) blocked.push({ name: r.name, step: d.stepNumber + 1, reason: f.reason, matches: f.matches });
      await recordFindings('outbound', findings, { conversationId, jobId: job._id, candidateId: r.candidateId }, `${d.subject}\n${d.body}`);
    }
  }
  if (blocked.length) {
    throw new ValidationError(
      `Guardrails blocked this campaign: ${blocked.slice(0, 4).map((b) => `${b.name} step ${b.step}: ${b.reason}${b.matches?.length ? ` (${b.matches.join(', ')})` : ''}`).join('; ')}. Edit the drafts and confirm again.`,
      { guardrails: blocked },
    );
  }

  const campaign = await Campaign.create({
    jobId: job._id,
    conversationId,
    name: p.name,
    status: 'running',
    dailyLimit: p.dailyLimit,
    dayMs: env.OUTREACH_DAY_MS,
    steps: p.steps,
    recipients: finalRecipients.map((r) => ({ ...r, state: 'active', nextStep: 0, nextRunAt: new Date() })),
    approvedAt: new Date(),
  });
  for (const r of finalRecipients) {
    await enqueue(
      QUEUE_NAMES.outreach,
      'send-step',
      { campaignId: String(campaign._id), candidateId: r.candidateId, step: 0 },
      { jobId: jobIds.outreach(String(campaign._id), r.candidateId, 0) },
    );
  }
  await logActivity({
    jobId: job._id,
    actor,
    action: 'campaign_approved',
    message: `Campaign "${p.name}" approved: ${finalRecipients.length} recipient(s), ${p.steps.length} step(s), daily limit ${p.dailyLimit}.`,
    meta: { campaignId: String(campaign._id), dropped },
  });
  await publish('campaign.progress', { campaignId: String(campaign._id), status: 'running' }, { jobId: job._id, conversationId });
  return { campaign, dropped };
}

/* ------------------------------------------------------------- Pause / resume */

export async function setCampaignPaused(campaignId: string, paused: boolean, actor: Actor) {
  const camp = await Campaign.findById(campaignId);
  if (!camp) throw new NotFoundError('Campaign');
  if (camp.status === 'completed') throw new ConflictError('CAMPAIGN_COMPLETED', 'This campaign has already completed.');
  const target = paused ? 'paused' : 'running';
  if (camp.status === target) return camp;
  camp.status = target;
  await camp.save();
  if (!paused) {
    // Jobs that came due while paused were parked with a short delay; promote those now.
    const now = Date.now();
    for (const r of camp.recipients) {
      if (r.state === 'active' && (!r.nextRunAt || r.nextRunAt.getTime() <= now)) {
        await promoteJob(QUEUE_NAMES.outreach, jobIds.outreach(String(camp._id), String(r.candidateId), r.nextStep ?? 0)).catch(() => false);
      }
    }
  }
  await logActivity({ jobId: camp.jobId, actor, action: paused ? 'campaign_paused' : 'campaign_resumed', meta: { campaignId } });
  await publish('campaign.progress', { campaignId, status: camp.status }, { jobId: camp.jobId });
  return camp;
}

/* ------------------------------------------------------------- Worker: send one step */

export type StepOutcome =
  | { action: 'sent'; previewUrl: string | null }
  | { action: 'skipped'; reason: string }
  | { action: 'delay'; until: number; reason: string };

export function windowStart(now: number, dayMs: number) {
  return Math.floor(now / dayMs) * dayMs;
}

async function reserveQuota(camp: CampaignDoc, now: number): Promise<boolean> {
  const window = windowStart(now, camp.dayMs);
  try {
    const doc = await SendQuota.findOneAndUpdate(
      { campaignId: camp._id, window, count: { $lt: camp.dailyLimit } },
      { $inc: { count: 1 } },
      { upsert: true, new: true },
    );
    return !!doc;
  } catch (err) {
    // Upsert raced with an existing doc whose count >= limit → duplicate key → limit reached.
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

async function releaseQuota(camp: CampaignDoc, now: number) {
  await SendQuota.updateOne({ campaignId: camp._id, window: windowStart(now, camp.dayMs), count: { $gt: 0 } }, { $inc: { count: -1 } });
}

async function stopRecipient(camp: CampaignDoc, candidateId: string, step: number, reason: string) {
  await Campaign.updateOne(
    { _id: camp._id, 'recipients.candidateId': candidateId },
    { $set: { 'recipients.$.state': 'stopped', 'recipients.$.stoppedReason': reason, 'recipients.$.nextRunAt': null } },
  );
  await DispatchLog.updateOne(
    { campaignId: camp._id, candidateId, stepNumber: step },
    { $setOnInsert: { jobId: camp.jobId, status: 'skipped', error: reason } },
    { upsert: true },
  );
  await maybeCompleteCampaign(String(camp._id));
}

/**
 * Outreach worker body. Order of checks matters:
 *   paused → candidate/recipient still eligible → daily quota → claim ledger row → SMTP → mark sent → schedule next.
 * The unique (campaignId, candidateId, stepNumber) ledger row is claimed BEFORE the SMTP call, so a
 * retry can never send the same step twice (at-most-once delivery).
 */
export async function processOutreachStep(campaignId: string, candidateId: string, step: number, now = Date.now()): Promise<StepOutcome> {
  const camp = await Campaign.findById(campaignId);
  if (!camp) return { action: 'skipped', reason: 'campaign not found' };
  const rec = camp.recipients.find((r) => String(r.candidateId) === candidateId);
  if (!rec || rec.state !== 'active') return { action: 'skipped', reason: 'recipient no longer active' };
  if ((rec.nextStep ?? 0) !== step) return { action: 'skipped', reason: `stale job (recipient is at step ${rec.nextStep})` };
  if (camp.status === 'paused') return { action: 'delay', until: now + 60_000, reason: 'campaign paused' };
  if (camp.status === 'completed') return { action: 'skipped', reason: 'campaign completed' };

  const cand = await Candidate.findById(candidateId);
  const expected = step === 0 ? 'Accepted' : 'Contacted';
  if (!cand) {
    await stopRecipient(camp, candidateId, step, 'candidate deleted');
    return { action: 'skipped', reason: 'candidate deleted' };
  }
  if (cand.outreachStopped || OUTREACH_BLOCKING.has(cand.status as never) || cand.status !== expected) {
    const reason = cand.outreachStopped ? `outreach stopped (${cand.outreachStoppedReason})` : `candidate is ${cand.status}`;
    await stopRecipient(camp, candidateId, step, reason);
    return { action: 'skipped', reason };
  }
  if (!cand.email) {
    await stopRecipient(camp, candidateId, step, 'no email');
    return { action: 'skipped', reason: 'no email' };
  }
  const draft = rec.drafts.find((d) => d.stepNumber === step);
  if (!draft) {
    await stopRecipient(camp, candidateId, step, 'missing draft');
    return { action: 'skipped', reason: 'missing draft' };
  }

  if (!(await reserveQuota(camp, now))) {
    const until = windowStart(now, camp.dayMs) + camp.dayMs + Math.floor(Math.random() * 5000);
    await Campaign.updateOne({ _id: camp._id, 'recipients.candidateId': cand._id }, { $set: { 'recipients.$.nextRunAt': new Date(until) } });
    await publish('campaign.progress', { campaignId, throttled: true }, { jobId: camp.jobId });
    return { action: 'delay', until, reason: `daily limit of ${camp.dailyLimit} reached` };
  }

  // Claim the ledger row (idempotency).
  try {
    await DispatchLog.create({
      campaignId: camp._id,
      jobId: camp.jobId,
      candidateId: cand._id,
      stepNumber: step,
      status: 'claimed',
      to: cand.email,
      subject: draft.subject,
      attempts: 1,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      await releaseQuota(camp, now);
      throw err;
    }
    const reclaimed = await DispatchLog.findOneAndUpdate(
      { campaignId: camp._id, candidateId: cand._id, stepNumber: step, status: 'failed' },
      { $set: { status: 'claimed', error: null }, $inc: { attempts: 1 } },
    );
    if (!reclaimed) {
      await releaseQuota(camp, now);
      return { action: 'skipped', reason: 'step already sent, claimed or cancelled' };
    }
  }

  const vars = { senderName: senderName(), firstName: firstName(cand.name) };
  const subject = fillPlaceholders(draft.subject, vars);
  const body = `${fillPlaceholders(draft.body, vars)}\n\n--\nNot interested? Reply "unsubscribe" and we won't contact you again.`;
  let sent;
  try {
    sent = await sendEmail({
      to: cand.email,
      subject,
      text: body,
      headers: { 'X-Airo-Campaign': campaignId, 'X-Airo-Step': String(step), 'List-Unsubscribe': '<mailto:unsubscribe@airorecruit.dev>' },
    });
  } catch (err) {
    await DispatchLog.updateOne({ campaignId: camp._id, candidateId: cand._id, stepNumber: step }, { $set: { status: 'failed', error: (err as Error).message } });
    await releaseQuota(camp, now);
    throw err; // BullMQ retries; the failed→claimed re-claim above allows exactly one in-flight attempt.
  }

  await DispatchLog.updateOne(
    { campaignId: camp._id, candidateId: cand._id, stepNumber: step },
    { $set: { status: 'sent', messageId: sent.messageId, previewUrl: sent.previewUrl, subject, body, sentAt: new Date(now) } },
  );

  if (step === 0) {
    try {
      await transition(cand._id, 'Contacted', { actor: 'worker', reason: `Campaign "${camp.name}" step 1 sent` });
    } catch (err) {
      logger.warn({ err: (err as Error).message, candidateId }, 'could not mark Contacted');
    }
  }
  await logActivity({
    jobId: camp.jobId,
    candidateId: cand._id,
    candidateName: cand.name,
    actor: 'worker',
    action: 'email_sent',
    message: `Step ${step + 1}/${camp.steps.length}: "${subject}"`,
    meta: { campaignId, step, previewUrl: sent.previewUrl, transport: sent.transport },
  });

  // Schedule the next step (only one pending job per candidate at any time).
  const next = camp.steps.find((s) => s.stepNumber === step + 1);
  const fresh = await Candidate.findById(cand._id, { outreachStopped: 1 });
  if (next && !fresh?.outreachStopped) {
    const cur = camp.steps.find((s) => s.stepNumber === step)!;
    const delay = Math.max(0, (next.delayDays - cur.delayDays) * camp.dayMs);
    const runAt = new Date(now + delay);
    const upd = await Campaign.updateOne(
      { _id: camp._id, recipients: { $elemMatch: { candidateId: cand._id, state: 'active' } } },
      { $set: { 'recipients.$.nextStep': next.stepNumber, 'recipients.$.nextRunAt': runAt } },
    );
    if (upd.modifiedCount) {
      await enqueue(
        QUEUE_NAMES.outreach,
        'send-step',
        { campaignId, candidateId, step: next.stepNumber },
        { jobId: jobIds.outreach(campaignId, candidateId, next.stepNumber), delay },
      );
    }
  } else {
    await Campaign.updateOne(
      { _id: camp._id, recipients: { $elemMatch: { candidateId: cand._id, state: 'active' } } },
      { $set: { 'recipients.$.state': next ? 'stopped' : 'completed', 'recipients.$.nextRunAt': null } },
    );
    await maybeCompleteCampaign(campaignId);
  }
  await publish('campaign.progress', { campaignId, sent: true, candidateId, step }, { jobId: camp.jobId });
  return { action: 'sent', previewUrl: sent.previewUrl };
}

/* ------------------------------------------------------------- Read model */

export async function campaignView(campaignId: string) {
  const camp = await Campaign.findById(campaignId).lean();
  if (!camp) throw new NotFoundError('Campaign');
  const logs = await DispatchLog.find({ campaignId }).lean();
  const now = Date.now();
  const quota = await SendQuota.findOne({ campaignId, window: windowStart(now, camp.dayMs) }).lean();
  const byCand = new Map<string, typeof logs>();
  for (const l of logs) {
    const k = String(l.candidateId);
    byCand.set(k, [...(byCand.get(k) ?? []), l]);
  }
  const recipients = camp.recipients.map((r) => ({
    candidateId: String(r.candidateId),
    name: r.name,
    email: r.email,
    state: r.state,
    nextStep: r.nextStep,
    nextRunAt: r.nextRunAt,
    stoppedReason: r.stoppedReason,
    drafts: r.drafts,
    steps: camp.steps.map((s) => {
      const l = (byCand.get(String(r.candidateId)) ?? []).find((x) => x.stepNumber === s.stepNumber);
      return {
        stepNumber: s.stepNumber,
        delayDays: s.delayDays,
        status: l?.status ?? (r.state === 'active' && (r.nextStep ?? 0) <= s.stepNumber ? 'scheduled' : 'not_sent'),
        sentAt: l?.sentAt ?? null,
        previewUrl: l?.previewUrl ?? null,
        error: l?.error ?? null,
      };
    }),
  }));
  const sent = logs.filter((l) => l.status === 'sent').length;
  return {
    id: String(camp._id),
    jobId: String(camp.jobId),
    name: camp.name,
    status: camp.status,
    dailyLimit: camp.dailyLimit,
    dayMs: camp.dayMs,
    steps: camp.steps,
    sentToday: quota?.count ?? 0,
    totals: {
      recipients: camp.recipients.length,
      active: camp.recipients.filter((r) => r.state === 'active').length,
      completed: camp.recipients.filter((r) => r.state === 'completed').length,
      stopped: camp.recipients.filter((r) => r.state === 'stopped').length,
      sent,
      plannedEmails: camp.recipients.length * camp.steps.length,
    },
    recipients,
    createdAt: camp.createdAt,
  };
}
