import { z } from 'zod';
import type { Types } from 'mongoose';
import { Campaign, Candidate, Job, Reply, REPLY_CLASSES, type ReplyClass } from '../models';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { normalizeEmail, firstName } from '../domain/normalize';
import { POST_CONTACT, type CandidateStatus } from '../domain/pipeline';
import { extractUrls, scanForInjection, wrapUntrusted } from '../domain/untrusted';
import { heuristicClassifyReply } from '../domain/heuristics';
import { json } from '../llm';
import { CLASSIFY_SYSTEM, REPLY_DRAFT_SYSTEM } from '../llm/prompts';
import { logActivity } from './activity.service';
import { publish } from './events';
import { stopOutreach, transition } from './pipeline.service';
import { enqueue, jobIds, QUEUE_NAMES } from '../queues/queues';
import { createProposal } from './proposals';
import { bookingUrl, createBooking } from './booking.service';
import { fillPlaceholders, sendEmail, senderName } from './mailer';
import { appendMessage } from './chat.service';
import { checkOutboundEmail } from '../guardrails/outbound';
import { recordFindings } from '../guardrails/engine';
import { detectUrgency } from '../guardrails/urgency';

export const CLASS_LABELS: Record<ReplyClass, string> = {
  interested: 'Interested',
  not_interested: 'Not interested',
  question: 'Question',
  wants_meeting: 'Wants a meeting',
  unsubscribe: 'Unsubscribe',
};

export const ClassificationSchema = z.object({
  classification: z.enum(REPLY_CLASSES),
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().max(300),
  questions: z.array(z.string().max(300)).max(10),
});

const DraftSchema = z.object({
  subject: z.string().trim().min(2).max(200),
  body: z.string().trim().min(10).max(3000),
});

export const SendReplyPayloadSchema = z.object({
  replyId: z.string(),
  candidateName: z.string().optional(),
  to: z.string().email(),
  subject: z.string().trim().min(2).max(200),
  body: z.string().trim().min(10).max(5000),
});
export type SendReplyPayload = z.infer<typeof SendReplyPayloadSchema>;

/* ------------------------------------------------------------- Inbound (simulate-reply) */

export interface InboundReply {
  candidateId?: string;
  email?: string;
  jobId?: string;
  subject?: string;
  body: string;
}

/**
 * Entry point for a candidate reply (real inbox webhook or POST /simulate-reply).
 * Preemption happens SYNCHRONOUSLY here, before anything else, so a queued follow-up can't
 * slip out while classification is running. Classification + drafting run in the `replies` queue.
 */
export async function receiveReply(input: InboundReply) {
  let cand;
  if (input.candidateId) {
    cand = await Candidate.findById(input.candidateId);
  } else if (input.email) {
    const email = normalizeEmail(input.email);
    if (!email) throw new AppError(400, 'INVALID_EMAIL', 'Invalid email');
    const matches = await Candidate.find({ emailLower: email, ...(input.jobId ? { jobId: input.jobId } : {}) }).sort({ updatedAt: -1 });
    if (matches.length > 1 && !input.jobId) {
      // Prefer the one actually contacted.
      cand = matches.find((m) => POST_CONTACT.has(m.status as CandidateStatus)) ?? matches[0];
    } else cand = matches[0];
  }
  if (!cand) throw new NotFoundError('Candidate');
  if (!POST_CONTACT.has(cand.status as CandidateStatus) && cand.status !== 'Unsubscribed') {
    throw new ConflictError('NOT_CONTACTED', `${cand.name} has not been contacted yet (status: ${cand.status}), so there is nothing to reply to.`);
  }

  const stoppedFollowUps = await stopOutreach(cand._id, 'candidate replied', 'candidate');
  if (cand.status === 'Contacted') {
    await transition(cand._id, 'Replied', { actor: 'candidate', reason: 'Candidate replied' });
  }
  const scan = scanForInjection(`${input.subject ?? ''}\n${input.body}`);
  const campaign = await Campaign.findOne({ 'recipients.candidateId': cand._id }).sort({ createdAt: -1 });
  const reply = await Reply.create({
    jobId: cand.jobId,
    candidateId: cand._id,
    campaignId: campaign?._id ?? null,
    subject: input.subject ?? null,
    body: input.body,
    injectionFlag: scan.flagged,
    injectionMatches: scan.matches,
    stoppedFollowUps,
  });
  await logActivity({
    jobId: cand.jobId,
    candidateId: cand._id,
    candidateName: cand.name,
    actor: 'candidate',
    action: 'reply_received',
    message: `Reply received${stoppedFollowUps ? `; ${stoppedFollowUps} pending follow-up(s) cancelled` : ''}${scan.flagged ? ' (possible prompt injection flagged)' : ''}`,
    meta: { replyId: String(reply._id) },
  });
  await enqueue(QUEUE_NAMES.replies, 'process-reply', { replyId: String(reply._id) }, { jobId: jobIds.reply(String(reply._id)) });
  await publish('reply.received', { replyId: String(reply._id), candidateId: String(cand._id) }, { jobId: cand.jobId });
  return { reply, candidate: cand, stoppedFollowUps };
}

/* ------------------------------------------------------------- Processing (worker) */

const STATUS_FOR: Partial<Record<ReplyClass, CandidateStatus>> = {
  interested: 'Interested',
  wants_meeting: 'Interested',
  not_interested: 'NotInterested',
  unsubscribe: 'Unsubscribed',
};

function templateDraft(cls: ReplyClass, name: string, jobTitle: string, link: string | null, questions: string[]) {
  const fn = firstName(name);
  switch (cls) {
    case 'wants_meeting':
      return { subject: `Re: ${jobTitle} - let's find a time`, body: `Hi ${fn},\n\nGreat to hear from you! Please pick a time that suits you here: ${link}\n\nLooking forward to our chat.\n\nBest,\n{{senderName}}` };
    case 'interested':
      return { subject: `Re: ${jobTitle}`, body: `Hi ${fn},\n\nThanks for getting back to me, glad this sounds interesting! Would you be open to a short intro call? Let me know a couple of times that work for you this week.\n\nBest,\n{{senderName}}` };
    case 'question':
      return {
        subject: `Re: ${jobTitle}`,
        body: `Hi ${fn},\n\nThanks for your question${questions.length > 1 ? 's' : ''}. I'll confirm the details with the hiring team and get back to you shortly. In the meantime, would a quick call help?\n\nBest,\n{{senderName}}`,
      };
    case 'not_interested':
      return { subject: `Re: ${jobTitle}`, body: `Hi ${fn},\n\nThanks for letting me know, I appreciate the reply. I'll keep you in mind for future roles that might be a better fit. All the best!\n\nBest,\n{{senderName}}` };
    default:
      return null;
  }
}

/** Strip any URL that isn't our booking link: drafts must never echo candidate-supplied links. */
function sanitizeDraft(body: string, allowed: string | null): string {
  let out = body;
  for (const url of extractUrls(body)) if (!allowed || url !== allowed) out = out.split(url).join('[link removed]');
  if (allowed && !out.includes(allowed)) out = `${out.trim()}\n\nPick a time here: ${allowed}`;
  return out;
}

/** Tool-less, schema-locked classification of untrusted candidate text. Also used by `npm run eval:replies`. */
export async function classifyReplyText(body: string, subject: string | null, jobTitle: string, jobId?: Types.ObjectId | string | null) {
  return json(
    {
      tier: 'fast',
      system: CLASSIFY_SYSTEM,
      prompt: `Job: ${jobTitle}\nWe emailed the candidate about this role. Their reply:\n${wrapUntrusted('candidate_email', `${subject ? `Subject: ${subject}\n` : ''}${body}`)}\n\nClassify it.`,
      schema: ClassificationSchema,
      schemaName: 'reply_classification',
      effort: 'low',
      maxTokens: 1000,
      mock: () => heuristicClassifyReply(body),
    },
    { purpose: 'reply_classification', jobId: jobId ?? null },
  );
}

export async function processReply(replyId: string) {
  const reply = await Reply.findById(replyId);
  if (!reply) throw new NotFoundError('Reply');
  if (reply.status === 'processed') return reply;
  const [cand, job] = await Promise.all([Candidate.findById(reply.candidateId), Job.findById(reply.jobId)]);
  if (!cand || !job) throw new NotFoundError('Candidate or job');

  const cls = await classifyReplyText(reply.body, reply.subject ?? null, job.title, job._id);
  // A flagged message never gets high confidence, so it can never qualify for auto-send.
  const confidence = reply.injectionFlag ? Math.min(cls.confidence, 0.5) : cls.confidence;

  // Status effect.
  const target = STATUS_FOR[cls.classification];
  let statusNote = '';
  if (target) {
    const fresh = await Candidate.findById(cand._id);
    if (fresh && fresh.status !== target) {
      try {
        await transition(cand._id, target, { actor: 'agent', reason: `Reply classified as ${CLASS_LABELS[cls.classification]}`, meta: { replyId } });
        statusNote = ` and moved them to ${target === 'NotInterested' ? 'Not interested' : target}`;
      } catch (err) {
        logger.info({ err: (err as Error).message }, 'reply status transition skipped');
      }
    }
  }

  // Draft (never for unsubscribe).
  let draft: { subject: string; body: string } | null = null;
  let link: string | null = null;
  if (cls.classification !== 'unsubscribe') {
    if (cls.classification === 'wants_meeting') {
      const booking = await createBooking(job._id, cand._id);
      reply.bookingToken = booking.token;
      link = bookingUrl(booking.token);
    }
    const jobData = {
      title: job.title,
      company: job.company,
      location: job.location,
      remotePolicy: job.remotePolicy,
      salary: job.salary?.raw ?? null,
      seniority: job.seniority,
      mustHaveSkills: job.mustHaveSkills,
      niceToHaveSkills: job.niceToHaveSkills,
      employmentType: job.employmentType,
      summary: job.summary,
    };
    const fallback = templateDraft(cls.classification, cand.name, job.title, link, cls.questions)!;
    draft = await json(
      {
        tier: 'agent',
        system: REPLY_DRAFT_SYSTEM,
        prompt: `JOB DATA (trusted):\n${JSON.stringify(jobData)}\n\nCLASSIFICATION: ${cls.classification}${cls.questions.length ? `\nQUESTIONS ASKED: ${cls.questions.join(' | ')}` : ''}\n${link ? `BOOKING LINK (include exactly once): ${link}\n` : ''}CANDIDATE FIRST NAME: ${firstName(cand.name)}\n\nCANDIDATE EMAIL:\n${wrapUntrusted('candidate_email', reply.body)}\n\nDraft the recruiter's reply. Subject should start with "Re: ".`,
        schema: DraftSchema,
        schemaName: 'reply_draft',
        effort: 'low',
        maxTokens: 2000,
        mock: () => fallback,
      },
      { purpose: 'reply_drafting', jobId: job._id },
    );
    draft = { subject: draft.subject, body: sanitizeDraft(draft.body, link) };
  }

  const urgency = detectUrgency(reply.body);
  const outbound = draft
    ? checkOutboundEmail({ subject: draft.subject, body: draft.body, recipientEmail: cand.email, allowedLinks: link ? [link] : [], job: { salaryRaw: job.salary?.raw } })
    : { verdict: 'pass' as const, findings: [] };
  if (reply.injectionFlag) {
    await recordFindings('reply', [{ rail: 'injection', verdict: 'warn', reason: 'Candidate reply contains instruction-like text; processed as data only.', matches: reply.injectionMatches }], { jobId: job._id, candidateId: cand._id }, reply.body);
  }
  if (urgency.level === 'high') {
    await recordFindings('reply', [{ rail: 'urgency', verdict: 'warn', reason: `Time-sensitive reply: ${urgency.signals.join(', ')}`, matches: urgency.signals }], { jobId: job._id, candidateId: cand._id });
  }
  await recordFindings('outbound', outbound.findings, { jobId: job._id, candidateId: cand._id }, draft ? draft.body : undefined);
  reply.priority = urgency.level;
  reply.urgencySignals = urgency.signals;

  reply.classification = cls.classification;
  reply.confidence = confidence;
  reply.summary = cls.summary;
  reply.status = 'processed';
  if (draft) {
    reply.draft = draft;
    reply.draftStatus = 'pending';
  }
  await reply.save();

  await logActivity({
    jobId: job._id,
    candidateId: cand._id,
    candidateName: cand.name,
    actor: 'agent',
    action: 'reply_classified',
    message: `${CLASS_LABELS[cls.classification]} (${Math.round(confidence * 100)}% confidence)`,
    meta: { replyId },
  });

  const label = CLASS_LABELS[cls.classification];
  const stopped = reply.stoppedFollowUps ? ` I stopped ${reply.stoppedFollowUps} pending follow-up${reply.stoppedFollowUps === 1 ? '' : 's'}` : ' Their sequence is stopped';
  const urgentNote = urgency.level === 'high' ? `\nTime-sensitive: ${urgency.signals.join(', ')}. Consider replying today.` : '';
  const injection = reply.injectionFlag ? '\nWarning: this reply contains text that looks like instructions to an AI. I treated it purely as data; please review carefully.' : '';

  // Auto-reply safety rules: only for meeting requests, high confidence, no injection flag,
  // and the draft contains no links other than our booking link.
  const autoEligible =
    !!draft &&
    job.settings?.autoReply === 'meetings_only' &&
    cls.classification === 'wants_meeting' &&
    confidence >= 0.8 &&
    !reply.injectionFlag &&
    outbound.verdict === 'pass' &&
    extractUrls(draft.body).every((u) => u === link);

  if (job.conversationId) {
    if (!draft) {
      await appendMessage(job.conversationId, {
        role: 'assistant',
        jobId: job._id,
        content: `${cand.name} asked to unsubscribe.${stopped}${statusNote}. They won't be emailed again.${injection}`,
        cards: [{ type: 'ACTION_RESULT', payload: { kind: 'unsubscribed', candidateId: String(cand._id), replyId, name: cand.name } }],
      });
    } else if (autoEligible) {
      await Reply.updateOne({ _id: reply._id }, { $set: { draftStatus: 'sending' } });
      await enqueue(QUEUE_NAMES.outreach, 'send-reply', { replyId, subject: draft.subject, body: draft.body, auto: true }, { jobId: jobIds.sendReply(replyId) });
      await logActivity({ jobId: job._id, candidateId: cand._id, candidateName: cand.name, actor: 'system', action: 'auto_reply_queued', message: 'Auto-reply (meetings only) passed all safety rules' });
      await appendMessage(job.conversationId, {
        role: 'assistant',
        jobId: job._id,
        content: `${cand.name} replied: ${label}.${stopped}${statusNote}. Auto-reply is on for meeting requests, so I sent them the booking link (all safety checks passed).`,
        cards: [{ type: 'REPLY_REVIEW', payload: { replyId, to: cand.email, candidateName: cand.name, subject: draft.subject, body: draft.body, autoSent: true, classification: cls.classification, confidence, summary: cls.summary, original: reply.body, injectionFlag: reply.injectionFlag } }],
      });
    } else {
      await createProposal({
        conversationId: job.conversationId,
        jobId: job._id,
        type: 'SEND_REPLY',
        proposedBy: 'system',
        supersedeKey: 'replyId',
        payload: { replyId, to: cand.email, candidateName: cand.name, subject: draft.subject, body: draft.body },
        display: {
          classification: cls.classification,
          classificationLabel: label,
          confidence,
          summary: cls.summary,
          original: reply.body,
          injectionFlag: reply.injectionFlag,
          injectionMatches: reply.injectionMatches,
          bookingUrl: link,
          stoppedFollowUps: reply.stoppedFollowUps,
          priority: urgency.level,
          urgencySignals: urgency.signals,
          guardrails: outbound.findings,
        },
        message: `${cand.name} replied: ${label} (${Math.round(confidence * 100)}% confidence).${stopped}${statusNote}. Here's a draft response; edit it if needed and approve to send.${urgentNote}${injection}`,
      });
    }
  }
  await publish('reply.processed', { replyId, classification: cls.classification, candidateId: String(cand._id) }, { jobId: job._id });
  await publish('state_sync', { reason: 'reply_processed', candidateIds: [String(cand._id)] }, { jobId: job._id });
  return reply;
}

/* ------------------------------------------------------------- Sending the approved draft */

/** Commit handler for SEND_REPLY: stores the (possibly edited) draft and queues the send. */
export async function approveReplySend(payload: SendReplyPayload, actor: 'user_ui' | 'user_chat') {
  const p = SendReplyPayloadSchema.parse(payload);
  const reply = await Reply.findOneAndUpdate(
    { _id: p.replyId, draftStatus: 'pending' },
    { $set: { draftStatus: 'sending', draft: { subject: p.subject, body: p.body } } },
    { new: true },
  );
  if (!reply) throw new ConflictError('REPLY_NOT_PENDING', 'This reply draft was already sent or discarded.');
  const cand = await Candidate.findById(reply.candidateId);
  const jobForCheck = await Job.findById(reply.jobId);
  const allowed = reply.bookingToken ? [bookingUrl(reply.bookingToken)] : [];
  const check = checkOutboundEmail({ subject: p.subject, body: p.body, recipientEmail: cand?.email, allowedLinks: allowed, job: { salaryRaw: jobForCheck?.salary?.raw } });
  await recordFindings('outbound', check.findings, { jobId: reply.jobId, candidateId: reply.candidateId }, `${p.subject}\n${p.body}`);
  if (check.verdict === 'block') {
    await Reply.updateOne({ _id: reply._id }, { $set: { draftStatus: 'pending' } });
    throw new ValidationError(
      `Guardrails blocked this reply: ${check.findings.filter((f) => f.verdict === 'block').map((f) => `${f.reason}${f.matches?.length ? ` (${f.matches.join(', ')})` : ''}`).join('; ')}. Edit the draft and approve again.`,
      { guardrails: check.findings },
    );
  }
  if (!cand?.email) throw new ConflictError('NO_EMAIL', 'Candidate has no email address.');
  if (cand.status === 'Unsubscribed') {
    await Reply.updateOne({ _id: reply._id }, { $set: { draftStatus: 'discarded' } });
    throw new ConflictError('UNSUBSCRIBED', `${cand.name} has unsubscribed; no email will be sent.`);
  }
  await enqueue(QUEUE_NAMES.outreach, 'send-reply', { replyId: p.replyId, subject: p.subject, body: p.body }, { jobId: jobIds.sendReply(p.replyId) });
  await logActivity({ jobId: reply.jobId, candidateId: reply.candidateId, candidateName: cand.name, actor, action: 'reply_approved' });
  return reply;
}

export async function discardReplyDraft(replyId: string) {
  await Reply.updateOne({ _id: replyId, draftStatus: 'pending' }, { $set: { draftStatus: 'discarded' } });
}

/** Worker body for `send-reply` (at-most-once via sendAttempted). */
export async function sendReplyNow(replyId: string, subject: string, body: string, auto = false) {
  const reply = await Reply.findOneAndUpdate(
    { _id: replyId, draftStatus: 'sending', sendAttempted: { $ne: true } },
    { $set: { sendAttempted: true } },
    { new: true },
  );
  if (!reply) return { skipped: true };
  const cand = await Candidate.findById(reply.candidateId);
  if (!cand?.email || cand.status === 'Unsubscribed') {
    await Reply.updateOne({ _id: replyId }, { $set: { draftStatus: 'discarded', error: 'candidate unsubscribed or has no email' } });
    return { skipped: true };
  }
  let sent;
  try {
    sent = await sendEmail({
      to: cand.email,
      subject: fillPlaceholders(subject, { senderName: senderName(), firstName: firstName(cand.name) }),
      text: fillPlaceholders(body, { senderName: senderName(), firstName: firstName(cand.name) }),
      headers: { 'X-Airo-Reply': replyId },
    });
  } catch (err) {
    await Reply.updateOne({ _id: replyId }, { $set: { sendAttempted: false, error: (err as Error).message } });
    throw err;
  }
  await Reply.updateOne(
    { _id: replyId },
    { $set: { draftStatus: auto ? 'auto_sent' : 'sent', sentMessageId: sent.messageId, sentPreviewUrl: sent.previewUrl, error: null } },
  );
  await logActivity({
    jobId: reply.jobId,
    candidateId: reply.candidateId,
    candidateName: cand.name,
    actor: auto ? 'system' : 'worker',
    action: 'reply_sent',
    message: auto ? 'Auto-reply sent' : 'Approved reply sent',
    meta: { previewUrl: sent.previewUrl },
  });
  await publish('state_sync', { reason: 'reply_sent', candidateIds: [String(cand._id)] }, { jobId: reply.jobId });
  return { skipped: false, previewUrl: sent.previewUrl };
}

export async function listReplies(jobId: Types.ObjectId | string, limit = 50) {
  return Reply.find({ jobId }).sort({ createdAt: -1 }).limit(limit).populate('candidateId', 'name email status').lean();
}
