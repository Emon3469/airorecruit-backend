import mongoose, { Schema, Types } from 'mongoose';
import { CANDIDATE_STATUSES } from '../domain/pipeline';
import { ACTION_TYPES, CARD_TYPES } from '../domain/cards';

const { ObjectId } = Schema.Types;
const opts = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ Conversation */
const ConversationSchema = new Schema(
  {
    title: { type: String, default: 'New conversation' },
    activeJobId: { type: ObjectId, ref: 'Job', default: null },
  },
  opts,
);
export const Conversation = mongoose.model('Conversation', ConversationSchema);
export type ConversationDoc = ReturnType<(typeof Conversation)["hydrate"]>;

/* ------------------------------------------------------------------ ChatMessage */
const CardSchema = new Schema(
  {
    type: { type: String, enum: CARD_TYPES, required: true },
    pendingActionId: { type: ObjectId, ref: 'PendingAction' },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const ChatMessageSchema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, default: '' },
    cards: { type: [CardSchema], default: [] },
    jobId: { type: ObjectId, ref: 'Job', default: null },
    /** Tool names the agent used to produce this message (debug/telemetry, shown on hover). */
    toolTrace: { type: [String], default: [] },
  },
  opts,
);
ChatMessageSchema.index({ conversationId: 1, createdAt: 1 });
export const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
export type ChatMessageDoc = ReturnType<(typeof ChatMessage)["hydrate"]>;

/* ------------------------------------------------------------------ PendingAction */
const PendingActionSchema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    jobId: { type: ObjectId, ref: 'Job', default: null },
    type: { type: String, enum: ACTION_TYPES, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'superseded', 'failed'],
      default: 'pending',
    },
    /** Who proposed it: the agent (chat) or the system (worker follow-ups like reply drafts). */
    proposedBy: { type: String, enum: ['agent', 'system', 'user_ui'], default: 'agent' },
    messageId: { type: ObjectId, ref: 'ChatMessage', default: null },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
  },
  opts,
);
PendingActionSchema.index({ conversationId: 1, status: 1 });
PendingActionSchema.index({ jobId: 1, type: 1, status: 1 });
export const PendingAction = mongoose.model('PendingAction', PendingActionSchema);
export type PendingActionDoc = ReturnType<(typeof PendingAction)["hydrate"]>;

/* ------------------------------------------------------------------ Job */
const UsageSchema = new Schema(
  {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    calls: { type: Number, default: 0 },
  },
  { _id: false },
);

const JobSchema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', default: null },
    title: { type: String, required: true },
    company: { type: String, default: null },
    mustHaveSkills: { type: [String], default: [] },
    niceToHaveSkills: { type: [String], default: [] },
    seniority: { type: String, default: null },
    location: { type: String, default: null },
    salary: {
      raw: { type: String, default: null },
      min: { type: Number, default: null },
      max: { type: Number, default: null },
      currency: { type: String, default: null },
      period: { type: String, default: null },
    },
    remotePolicy: { type: String, enum: ['remote', 'hybrid', 'onsite', 'unspecified'], default: 'unspecified' },
    employmentType: { type: String, default: null },
    summary: { type: String, default: null },
    rawJD: { type: String, required: true },
    sourceUrl: { type: String, default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    settings: {
      /** off: every reply waits for approval. meetings_only: auto-send low-risk meeting replies (see safety rules). */
      autoReply: { type: String, enum: ['off', 'meetings_only'], default: 'off' },
    },
    usage: { type: UsageSchema, default: () => ({}) },
  },
  opts,
);
JobSchema.index({ title: 'text' });
export const Job = mongoose.model('Job', JobSchema);
export type JobDoc = ReturnType<(typeof Job)["hydrate"]>;

/* ------------------------------------------------------------------ Candidate */
const CandidateSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true },
    name: { type: String, required: true },
    headline: { type: String, default: null },
    location: { type: String, default: null },
    currentCompany: { type: String, default: null },
    yearsExperience: { type: Number, default: null },
    skills: { type: [String], default: [] },
    profileUrl: { type: String, default: null },
    profileUrlCanonical: { type: String, default: undefined },
    email: { type: String, default: null },
    emailLower: { type: String, default: undefined },
    /** Provenance. Emails are never inferred: they come from a CSV or a manual edit, or stay null. */
    emailSource: { type: String, enum: ['csv', 'manual', null], default: null },
    source: { type: String, enum: ['serper', 'csv', 'manual', 'talent_pool'], required: true },
    sources: { type: [String], default: [] },
    /** UNTRUSTED: raw snippet / notes from the web or CSV. Only ever sent to an LLM wrapped in untrusted tags. */
    snippet: { type: String, default: null },
    injectionFlag: { type: Boolean, default: false },

    score: { type: Number, default: null, min: 0, max: 100 },
    scoreReason: { type: String, default: null },
    scoreConfidence: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    matchedSkills: { type: [String], default: [] },
    missingData: { type: [String], default: [] },
    scoringStatus: { type: String, enum: ['pending', 'scored', 'failed'], default: 'pending' },
    /** Last SourcingRun that counted this candidate's score; makes progress counting idempotent on retries. */
    scoredRunId: { type: ObjectId, default: null },

    status: { type: String, enum: CANDIDATE_STATUSES, default: 'Sourced' },
    rejectedStage: { type: String, enum: ['review', 'final', null], default: null },
    /** Every status this candidate has ever reached. Drives the cumulative funnel. */
    milestones: { type: [String], default: ['Sourced'] },
    outreachStopped: { type: Boolean, default: false },
    outreachStoppedReason: { type: String, default: null },
    lastContactedAt: { type: Date, default: null },
  },
  opts,
);
CandidateSchema.index(
  { jobId: 1, emailLower: 1 },
  { unique: true, partialFilterExpression: { emailLower: { $type: 'string' } } },
);
CandidateSchema.index(
  { jobId: 1, profileUrlCanonical: 1 },
  { unique: true, partialFilterExpression: { profileUrlCanonical: { $type: 'string' } } },
);
CandidateSchema.index({ jobId: 1, status: 1 });
CandidateSchema.index({ jobId: 1, score: -1 });
export const Candidate = mongoose.model('Candidate', CandidateSchema);
export type CandidateDoc = ReturnType<(typeof Candidate)["hydrate"]>;

/* ------------------------------------------------------------------ CsvUpload */
const CsvUploadSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true },
    filename: { type: String, default: 'upload.csv' },
    rows: { type: [Schema.Types.Mixed], default: [] },
    rowCount: { type: Number, default: 0 },
    invalidRows: { type: [Schema.Types.Mixed], default: [] },
    status: { type: String, enum: ['uploaded', 'imported'], default: 'uploaded' },
  },
  opts,
);
export const CsvUpload = mongoose.model('CsvUpload', CsvUploadSchema);

/* ------------------------------------------------------------------ SourcingRun */
const SourcingRunSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true },
    conversationId: { type: ObjectId, ref: 'Conversation', default: null },
    status: { type: String, enum: ['queued', 'searching', 'importing', 'scoring', 'completed', 'failed'], default: 'queued' },
    query: { type: String, default: null },
    useWebSearch: { type: Boolean, default: true },
    includeTalentPool: { type: Boolean, default: false },
    poolFound: { type: Number, default: 0 },
    maxResults: { type: Number, default: 20 },
    csvUploadIds: { type: [ObjectId], default: [] },
    webFound: { type: Number, default: 0 },
    csvRows: { type: Number, default: 0 },
    found: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    enriched: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    scored: { type: Number, default: 0 },
    scoreFailed: { type: Number, default: 0 },
    candidateIds: { type: [ObjectId], default: [] },
    notes: { type: [String], default: [] },
    error: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  opts,
);
export const SourcingRun = mongoose.model('SourcingRun', SourcingRunSchema);
export type SourcingRunDoc = ReturnType<(typeof SourcingRun)["hydrate"]>;

/* ------------------------------------------------------------------ Campaign */
const StepSchema = new Schema(
  { stepNumber: { type: Number, required: true }, delayDays: { type: Number, required: true }, label: String },
  { _id: false },
);
const DraftSchema = new Schema(
  { stepNumber: { type: Number, required: true }, subject: { type: String, required: true }, body: { type: String, required: true } },
  { _id: false },
);
const RecipientSchema = new Schema(
  {
    candidateId: { type: ObjectId, ref: 'Candidate', required: true },
    name: String,
    email: String,
    drafts: { type: [DraftSchema], default: [] },
    state: { type: String, enum: ['active', 'completed', 'stopped'], default: 'active' },
    nextStep: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: null },
    stoppedReason: { type: String, default: null },
  },
  { _id: false },
);
const CampaignSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true },
    conversationId: { type: ObjectId, ref: 'Conversation', default: null },
    name: { type: String, default: 'Outreach' },
    status: { type: String, enum: ['running', 'paused', 'completed'], default: 'running' },
    dailyLimit: { type: Number, required: true },
    dayMs: { type: Number, required: true },
    steps: { type: [StepSchema], default: [] },
    recipients: { type: [RecipientSchema], default: [] },
    approvedAt: { type: Date, default: null },
  },
  opts,
);
CampaignSchema.index({ jobId: 1 });
CampaignSchema.index({ 'recipients.candidateId': 1 });
export const Campaign = mongoose.model('Campaign', CampaignSchema);
export type CampaignDoc = ReturnType<(typeof Campaign)["hydrate"]>;

/* ------------------------------------------------------------------ DispatchLog (idempotency ledger) */
const DispatchLogSchema = new Schema(
  {
    campaignId: { type: ObjectId, ref: 'Campaign', required: true },
    jobId: { type: ObjectId, ref: 'Job', required: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true },
    stepNumber: { type: Number, required: true },
    status: { type: String, enum: ['claimed', 'sent', 'failed', 'cancelled', 'skipped'], required: true },
    to: String,
    subject: String,
    body: String,
    messageId: { type: String, default: null },
    previewUrl: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
  },
  opts,
);
DispatchLogSchema.index({ campaignId: 1, candidateId: 1, stepNumber: 1 }, { unique: true });
DispatchLogSchema.index({ campaignId: 1, status: 1, sentAt: 1 });
DispatchLogSchema.index({ jobId: 1, status: 1 });
export const DispatchLog = mongoose.model('DispatchLog', DispatchLogSchema);

/* ------------------------------------------------------------------ SendQuota (atomic daily limit) */
const SendQuotaSchema = new Schema(
  {
    campaignId: { type: ObjectId, ref: 'Campaign', required: true },
    /** Window start (ms since epoch). One window = one campaign "day" (Campaign.dayMs). */
    window: { type: Number, required: true },
    count: { type: Number, default: 0 },
  },
  { versionKey: false },
);
SendQuotaSchema.index({ campaignId: 1, window: 1 }, { unique: true });
export const SendQuota = mongoose.model('SendQuota', SendQuotaSchema);

/* ------------------------------------------------------------------ Reply */
export const REPLY_CLASSES = ['interested', 'not_interested', 'question', 'wants_meeting', 'unsubscribe'] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

const ReplySchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true },
    campaignId: { type: ObjectId, ref: 'Campaign', default: null },
    subject: { type: String, default: null },
    /** UNTRUSTED candidate text. */
    body: { type: String, required: true },
    status: { type: String, enum: ['received', 'processed', 'failed'], default: 'received' },
    classification: { type: String, enum: [...REPLY_CLASSES, null], default: null },
    confidence: { type: Number, default: null },
    summary: { type: String, default: null },
    injectionFlag: { type: Boolean, default: false },
    injectionMatches: { type: [String], default: [] },
    stoppedFollowUps: { type: Number, default: 0 },
    /** Urgency rail: competing offers / deadlines make a reply high priority. */
    priority: { type: String, enum: ['high', 'normal'], default: 'normal' },
    urgencySignals: { type: [String], default: [] },
    draft: {
      subject: { type: String, default: null },
      body: { type: String, default: null },
    },
    draftStatus: { type: String, enum: ['none', 'pending', 'sending', 'sent', 'discarded', 'auto_sent'], default: 'none' },
    bookingToken: { type: String, default: null },
    /** At-most-once guard for sending the approved draft. */
    sendAttempted: { type: Boolean, default: false },
    sentMessageId: { type: String, default: null },
    sentPreviewUrl: { type: String, default: null },
    error: { type: String, default: null },
  },
  opts,
);
ReplySchema.index({ jobId: 1, createdAt: -1 });
export const Reply = mongoose.model('Reply', ReplySchema);
export type ReplyDoc = ReturnType<(typeof Reply)["hydrate"]>;

/* ------------------------------------------------------------------ Booking */
const BookingSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    jobId: { type: ObjectId, ref: 'Job', required: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true },
    slots: { type: [Date], default: [] },
    chosenSlot: { type: Date, default: null },
    bookedAt: { type: Date, default: null },
  },
  opts,
);
export const Booking = mongoose.model('Booking', BookingSchema);

/* ------------------------------------------------------------------ ActivityLog (append-only) */
const ActivityLogSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', default: null },
    candidateId: { type: ObjectId, ref: 'Candidate', default: null },
    candidateName: { type: String, default: null },
    actor: { type: String, enum: ['user_ui', 'user_chat', 'agent', 'worker', 'system', 'candidate'], required: true },
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    message: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
ActivityLogSchema.index({ jobId: 1, createdAt: -1 });
ActivityLogSchema.index({ candidateId: 1, createdAt: -1 });
// Append-only: block updates and deletes at the model level.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  ActivityLogSchema.pre(op, function () {
    throw new Error('ActivityLog is append-only');
  });
}
export const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);

/* ------------------------------------------------------------------ LlmUsage */
const LlmUsageSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', default: null },
    conversationId: { type: ObjectId, ref: 'Conversation', default: null },
    purpose: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    /** LLMOps: short hash of the system prompt, so metrics can be compared across prompt versions. */
    promptVersion: { type: String, default: null },
    /** ok | repaired (needed the schema-repair retry) | schema_error | error | mock | budget_fallback */
    status: { type: String, default: 'ok' },
    error: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
LlmUsageSchema.index({ jobId: 1, createdAt: -1 });
export const LlmUsage = mongoose.model('LlmUsage', LlmUsageSchema);

/* ------------------------------------------------------------------ GuardrailEvent (audit of every rail trigger) */
const GuardrailEventSchema = new Schema(
  {
    stage: { type: String, required: true },
    rail: { type: String, required: true },
    verdict: { type: String, enum: ['pass', 'warn', 'block'], required: true },
    reason: { type: String, default: null },
    matches: { type: [String], default: [] },
    conversationId: { type: ObjectId, ref: 'Conversation', default: null },
    jobId: { type: ObjectId, ref: 'Job', default: null },
    candidateId: { type: ObjectId, ref: 'Candidate', default: null },
    /** Redacted, truncated excerpt of the checked text (never contains secrets). */
    sample: { type: String, default: null },
    via: { type: String, default: null },
    score: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
GuardrailEventSchema.index({ createdAt: -1 });
GuardrailEventSchema.index({ jobId: 1, createdAt: -1 });
GuardrailEventSchema.index({ rail: 1, verdict: 1 });
export const GuardrailEvent = mongoose.model('GuardrailEvent', GuardrailEventSchema);

/* ------------------------------------------------------------------ AppSetting (key/value) */
const AppSettingSchema = new Schema(
  { key: { type: String, required: true, unique: true }, value: { type: Schema.Types.Mixed } },
  opts,
);
export const AppSetting = mongoose.model('AppSetting', AppSettingSchema);

export function oid(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
}
