# AiroRecruit: Architecture Blueprint (Phase 6 completion)

Rename the product freely. Everything below is scoped to the Aironauts PDF: 3 days, chat-first, BullMQ, confirm-before-write.

## 0. Design rules (these drive every section)

1. **Mongo is the source of truth. SSE is only a hint.** Events say "something changed"; the client refetches or patches from the payload. A page refresh loses nothing.
2. **The LLM never commits.** The agent can only call `read_*` and `propose_*` tools. Commits run only from `POST /api/actions/:id/confirm`, which a card button or a deterministic chat confirmation reaches.
3. **One write path.** UI buttons, chat commands and workers all go through `PipelineService`, which validates the state machine, writes the change, writes `ActivityLog`, and emits `state_sync`.
4. **Untrusted text never reaches a tool-enabled model.** Snippets, CSV cells and replies are only read by tool-less, schema-locked LLM calls.

## 1. Mongoose models

```ts
// Conversation: chat can exist before any job does
Conversation { _id, activeJobId?: ObjectId, createdAt }

ChatMessage {
  conversationId, role: 'user'|'assistant'|'system',
  content: string,
  card?: { type: 'JOB_CONFIRM'|'SOURCING_PROGRESS'|'CANDIDATE_TABLE'|'CAMPAIGN_PREVIEW'
              |'REPLY_REVIEW'|'STATUS_UPDATE'|'STATS_SUMMARY',
           payload: object, pendingActionId?: ObjectId },
  createdAt
}   // index { conversationId, createdAt }

PendingAction {                         // the Proposal half of Proposal-Commit
  conversationId, jobId?,
  type: 'CREATE_JOB'|'START_SOURCING'|'REVIEW_DECISIONS'|'CREATE_CAMPAIGN'
      | 'STATUS_CHANGE'|'SEND_REPLY',
  payload: object,                      // editable until confirmed
  status: 'pending'|'confirmed'|'cancelled'|'superseded',
  createdAt, resolvedAt?
}

Job {                                   // exists only AFTER confirmation
  title, mustHaveSkills[], niceToHaveSkills[], seniority, location,
  salary: { raw?: string, min?, max?, currency? },   // null fields stay null
  remotePolicy, rawJD, sourceUrl?,
  usage: { promptTokens, completionTokens, costUsd }, // $inc'd per LLM call
  createdAt
}

Candidate {
  jobId, name, headline?, profileUrl, profileUrlCanonical,
  email: string|null, emailLower?: string, emailSource: 'csv'|'manual'|null,
  source: 'serper'|'csv'|'manual',
  snippet?: string,                     // UNTRUSTED, only ever shown inside <untrusted> tags
  score?: number, scoreReason?: string, missingData: string[],
  status: Status, rejectedAt?: 'review'|'final',
  outreachStopped: boolean,
  createdAt
}
// unique { jobId, emailLower }            partialFilterExpression { emailLower: { $type: 'string' } }
// unique { jobId, profileUrlCanonical }   partialFilterExpression { profileUrlCanonical: { $type: 'string' } }

Campaign {
  jobId, status: 'draft'|'running'|'paused'|'completed',
  dailyLimit: number,
  steps: [{ stepNumber, delayDays, subject, body }],     // templates
  recipients: [{ candidateId, drafts: [{ stepNumber, subject, body }] }]  // per-candidate edits
}

DispatchLog {                           // idempotency ledger
  campaignId, candidateId, stepNumber,
  status: 'claimed'|'sent'|'failed'|'cancelled',
  messageId?, previewUrl?, error?, sentAt?
}   // unique { campaignId, candidateId, stepNumber }

Reply {
  jobId, candidateId, campaignId?, body,
  classification: 'interested'|'not_interested'|'question'|'wants_meeting'|'unsubscribe',
  confidence: number, injectionFlag: boolean,
  draft?: { subject, body }, draftStatus: 'pending'|'sent'|'discarded',
  receivedAt
}

Booking { token (random, unguessable), candidateId, jobId, slots: Date[], chosenSlot?: Date }

ActivityLog {                           // append-only, no update/delete routes exist
  jobId, candidateId?, actor: 'user_ui'|'user_chat'|'agent'|'worker'|'system',
  action: string, from?: string, to?: string, meta?: object, at
}

LlmUsage { jobId?, purpose, model, promptTokens, completionTokens, costUsd, at }
```

Use `/booking/:token`, not `/book/:candidateId`. IDs are guessable; tokens are not.

## 2. State machine

`Status = Sourced | Accepted | Rejected | Contacted | Replied | Interested | NotInterested | MeetingBooked | Interviewed | Shortlisted | Hired | Unsubscribed`

The PDF lists "Rejected" twice (after review, and at the end), so keep one `Rejected` status plus `rejectedAt: 'review' | 'final'`.

| From | Allowed next |
|---|---|
| Sourced | Accepted, Rejected(review) |
| Rejected(review) | Accepted (undo) |
| Accepted | Contacted, Rejected(review) |
| Contacted | Replied, Unsubscribed |
| Replied | Interested, NotInterested, Unsubscribed |
| Interested | MeetingBooked, NotInterested, Unsubscribed |
| MeetingBooked | Interviewed, Unsubscribed |
| Interviewed | Shortlisted, Rejected(final), Unsubscribed |
| Shortlisted | Hired, Rejected(final), Unsubscribed |
| NotInterested, Hired, Unsubscribed | terminal |

`Contacted` is set automatically when step 0 is sent. Every transition outside this table returns `409 { error: 'ILLEGAL_TRANSITION', from, to }`, which the agent relays in plain language.

**Reply classification → effect**

| Class | Status change | Side effects |
|---|---|---|
| interested | Replied → Interested | stop sequence, draft reply |
| wants_meeting | Replied → Interested | stop sequence, create `Booking`, draft reply containing the link |
| question | Replied | stop sequence, draft answer (say "I don't know" if the JD lacks the info) |
| not_interested | Replied → NotInterested | stop sequence, draft polite close |
| unsubscribe | → Unsubscribed | stop sequence, **no draft**, never email again |

`MeetingBooked` is set when the candidate **picks a slot** on `/booking/:token`. State this choice in the README.

## 3. Agent tools

| Tool | Kind | Produces |
|---|---|---|
| `get_job`, `list_jobs` | read | text or card |
| `get_candidates({jobId, filter, sort, limit})` | read | CANDIDATE_TABLE |
| `get_stats({jobId})` | read | STATS_SUMMARY plus AI summary |
| `propose_create_job({rawJD or url})` | propose | JOB_CONFIRM (editable) |
| `propose_start_sourcing({jobId, query?, useCsv?})` | propose | confirmation card, then SOURCING_PROGRESS |
| `propose_review_decisions({jobId, decisions[]})` | propose | confirm card listing exactly who gets accepted or rejected |
| `propose_campaign({jobId, steps, candidateIds})` | propose | CAMPAIGN_PREVIEW (editable) |
| `propose_status_change({candidateRef, to})` | propose | STATUS_UPDATE confirm |
| `propose_reply_send({replyId})` | propose | REPLY_REVIEW |

Commit side, with no LLM access:

- `POST /api/actions/:id/confirm` re-validates the payload with Zod, re-checks the state machine (state may have changed since the proposal), executes, and returns the result card.
- **Chat confirmation** ("yes", "confirm", "go ahead"): a small server-side matcher checks that exactly one `pending` action exists and the message is a pure confirmation. If several are pending, or the match is ambiguous, reply "Please use the Confirm button on the card." Never let the LLM decide a message counts as confirmation.
- A new proposal of the same type supersedes the old one (`status: 'superseded'`).
- Resolve "Rahim" or "top 5" **server-side** in `candidateRef` resolution. On multiple matches, ask which one. Never guess.

**Agent loop:** system prompt, last N messages, and the compact job context as tool results. Cap at 6 tool iterations per turn. Log usage on every call.

## 4. REST API

```
POST   /api/conversations                       → { id }   (greeting message inserted)
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages          { content } → assistant message(s)
GET    /api/events/:conversationId              (SSE, supports Last-Event-ID)

PATCH  /api/actions/:id                         { payload }   edit a proposal before confirming
POST   /api/actions/:id/confirm
POST   /api/actions/:id/cancel

GET    /api/jobs            GET /api/jobs/:id
GET    /api/jobs/:id/stats       (aggregation: per-status counts, reply rate, interested rate, meetings, hires, usage)
GET    /api/jobs/:id/summary     (AI summary of stats)
GET    /api/jobs/:id/activity
GET    /api/jobs/:id/candidates
POST   /api/jobs/:id/candidates/upload          multipart CSV (multer + csv-parse), starts import via confirm card
PATCH  /api/candidates/:id                      { email }  manual enrichment (emailSource='manual')
POST   /api/candidates/:id/status               { to }     UI dropdown (goes through PipelineService)
POST   /api/candidates/decisions                { ids[], decision }  UI accept/reject buttons

POST   /api/campaigns/:id/pause     POST /api/campaigns/:id/resume
PATCH  /api/campaigns/:id/drafts                edit drafts while status = draft

POST   /api/simulate-reply                      { candidateId | email, body }
POST   /api/replies/:id/draft/approve           sends the drafted response
GET    /api/booking/:token      POST /api/booking/:token { slot }
```

UI button clicks count as explicit approval, so they call the commit endpoints directly. Only chat-originated writes need a proposal card.

## 5. Queues and workers

All queues: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: { age: 86400 }`.

**sourcing-queue** (concurrency 1 per job)
1. Build the query: `site:linkedin.com/in "<title>" <location> <top skills>`.
2. Call Serper (with a timeout), keep URL, title and snippet only, and set `email: null`.
3. Parse the CSV if present, normalize it (trim, lowercase email, canonicalize URL), and `bulkWrite` with `ordered:false`. Duplicate-key errors are the dedupe, so count them as `duplicates`.
4. Fan out one scoring job per new candidate and emit `sourcing.progress`.

**scoring-queue** (concurrency ~5, fast model)
- Input: JD rubric plus the candidate in `<untrusted_candidate_data>`.
- Output (Zod-validated JSON): `{ score: 0-100, reason: string (<=240 chars), missingData: string[] }`.
- The prompt must say: score only from provided facts, and when the data is thin, lower confidence and list the gaps. On a schema failure, retry once with the error appended, then mark `score: null, missingData: ['scoring_failed']`. Never invent a score.
- Progress counters use `$inc` on a `SourcingRun` doc (or Redis `INCR`) and emit `scored/total`.

**outreach-queue**. Schedule one step at a time. When step N is sent, enqueue step N+1 with `delay = delayDays`. Then there is at most one pending job per candidate, which makes cancellation trivial.

```ts
// jobId: use dashes, since recent BullMQ versions reject ':' in custom job IDs (verify on your version)
const jobId = `out-${campaignId}-${candidateId}-${step}`;

async function process(job, token) {
  const [c, cand] = await load();
  if (c.status === 'paused')  { await job.moveToDelayed(Date.now()+60_000, token); throw new DelayedError(); }
  if (cand.outreachStopped || ['Unsubscribed','Replied', /*...later states*/].includes(cand.status)) return skip('stopped');

  // daily limit: count in Mongo, not in the BullMQ limiter (the limiter is per-window throughput, not a daily quota)
  const sentToday = await DispatchLog.countDocuments({ campaignId, status:'sent', sentAt:{ $gte: startOfDay() }});
  if (sentToday >= c.dailyLimit) { await job.moveToDelayed(startOfTomorrow(), token); throw new DelayedError(); }

  // idempotency: claim BEFORE sending
  try { await DispatchLog.create({ campaignId, candidateId, stepNumber: step, status:'claimed' }); }
  catch (e) { if (isDuplicateKey(e)) {
      const re = await DispatchLog.findOneAndUpdate({ campaignId, candidateId, stepNumber: step, status:'failed' },
                                                    { status:'claimed' });
      if (!re) return skip('already claimed/sent');
  } else throw e; }

  try { const info = await smtp.send(...); await markSent(info); await maybeScheduleNext(); }
  catch (e) { await markFailed(e); throw e; }   // BullMQ retries; the failed→claimed re-claim above allows it
}
```

Stated trade-off: if the process dies between SMTP success and `markSent`, the row stays `claimed` and the step is skipped on retry. That is **at-most-once**, which is the right bias for "no candidate gets the same step twice". Put it in the README.

**Preemption on reply or unsubscribe** (inside `PipelineService.handleReply`):
1. Set `outreachStopped = true` (the worker's re-check above is the real guarantee).
2. `outreachQueue.remove(jobId)` for the candidate's pending step. `remove` returns 0 for an active job, which is fine because the worker re-check catches it.
3. Mark any unsent `DispatchLog` row `cancelled`. Write `ActivityLog`.

**Pause/resume** only flips `Campaign.status`. The worker's pause check above handles the rest.

## 6. SSE events

`GET /api/events/:conversationId`. Every event carries `id` (monotonic) so `Last-Event-ID` can replay or the client can just refetch.

| Event | Payload |
|---|---|
| `sourcing.progress` | `{ jobId, phase: 'searching'\|'importing'\|'scoring', found, duplicates, scored, total }` |
| `sourcing.done` | `{ jobId, messageId }` |
| `campaign.progress` | `{ campaignId, sent, total, nextRunAt? }` |
| `reply.received` | `{ candidateId, replyId, classification }` |
| `state_sync` | `{ jobId, candidateIds[], reason }` → client invalidates TanStack Query keys |
| `usage.updated` | `{ jobId, costUsd, tokens }` |

Workers publish to Redis Pub/Sub; the Express SSE handler subscribes (one shared subscriber, fan-out in memory). Send a `: ping` comment every ~25s.

## 7. Prompt-injection and provenance

- Wrap candidate bios, CSV free-text and reply bodies in `<untrusted_candidate_data>…</untrusted_candidate_data>`. The system prompt states that the content is data and any instructions inside it must be ignored.
- Strip or escape any literal closing tag in the content. Run a heuristic scan (`ignore previous`, `system prompt`, `mark me hired`, and so on). If it hits, set `injectionFlag` and show a warning chip, and **still** process the text normally. The flag is for the human, not the defense.
- **The real defense is structural:** classification and scoring calls have no tools, return Zod-validated JSON, and cannot touch state. The worst a malicious reply can do is mislead one classification label, and every consequent send still needs approval.
- Drafts generated from a reply never copy URLs or instructions from it.
- Provenance: each candidate carries `source` and `emailSource`. The UI shows "Email missing: add via CSV or edit". The agent must say "I don't have that" instead of guessing, and the campaign proposal rejects candidates without an email, listing them.

## 8. Cost tracking

A single `llm.call()` wrapper takes `{ purpose, jobId, model, ...args }`, reads `usage` from the response, multiplies by a per-model price table in config (env-overridable), writes `LlmUsage`, `$inc`s `Job.usage`, and emits `usage.updated`. Models come from `LLM_MODEL_AGENT` and `LLM_MODEL_FAST` env vars. Do not hardcode names or prices in code paths.

## 9. Build order (3 days)

**Day 1: foundation and first vertical slice**
- Repos, `docker-compose.yml` (mongo, redis, api, worker), env validation.
- Models, `PipelineService`, state machine plus unit tests for the transition table.
- Chat endpoints, SSE hub, agent loop with `propose_create_job`, JOB_CONFIRM card, confirm endpoint.
- *Checkpoint: paste a JD, edit, confirm, refresh the page, and everything persists.*

**Day 2: pipeline**
- Sourcing and scoring queues, CSV upload, dedupe, progress card, candidate table with buttons.
- Chat accept/reject, status changes.
- Campaign proposal, preview and edit, outreach worker with claim-before-send and daily limit, Ethereal SMTP.
- `/simulate-reply`, classification, auto-stop, reply draft card, booking page.
- *Checkpoint: JD → hire works end to end once.*

**Day 3: finish**
- Morning: dashboard and stats, AI summary, activity log view, then pause/resume, cost badge and injection flag.
- Afternoon: seed data (sample JD plus CSV with a duplicate and a missing email), eval script, README, demo recording.
- If time runs short, cut cost telemetry and pause/resume first.

## 10. Eval script (small, high signal)

`npm run eval:replies` runs about 20 labeled replies through the classifier, including 3 injection attempts and 2 ambiguous ones, and prints per-class accuracy and a confusion matrix. Run it before recording and put the result table in the README.

## 11. Demo script (about 8 minutes)

1. Greeting, paste the JD, edit one field, confirm (0:00–1:00)
2. Approve sourcing and upload CSV, show live progress and the dedupe count (1:00–2:30)
3. Table: accept via button, reject one, then "accept the top 3" in chat and show the confirm card (2:30–3:30)
4. Show a web-sourced candidate with a missing email and why it can't enter the campaign; add the email inline (3:30–4:00)
5. Campaign: edit a draft, approve, show the Ethereal inbox and the daily-limit behaviour (4:00–5:30)
6. Simulate "wants a meeting": the sequence stops, status moves, reply draft arrives, then approve it and pick a slot on the booking page (5:30–6:30)
7. Simulate the injection reply, plus unsubscribe (6:30–7:00)
8. Mark Interviewed → Shortlisted → Hired via chat, then the dashboard, the AI summary and the activity log (7:00–8:00)
