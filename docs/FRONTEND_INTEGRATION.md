# Frontend integration guide

The backend and frontend are separate repositories (as the assignment requires). This is the contract between
them. The frontend needs exactly one setting: the API base URL.

```bash
# frontend .env
VITE_API_URL=http://localhost:4000
```

```bash
# backend .env: allow the frontend origin and point booking links at the frontend page
CORS_ORIGINS=http://localhost:5173
PUBLIC_BOOKING_BASE_URL=http://localhost:5173/booking
```

## Shared types (single source of truth)

These two backend files are dependency-free TypeScript. Copy them into the frontend (e.g. `src/contracts/`) and
keep them in sync when the backend changes:

| File | Exports |
|---|---|
| `src/domain/cards.ts` | `CARD_TYPES`, `Card`, `ACTION_TYPES`, `ACTION_CARD`, `Actor` |
| `src/domain/pipeline.ts` | `CANDIDATE_STATUSES`, `STATUS_LABELS`, `FUNNEL_STAGES`, `allowedNext()`, `canTransition()` |

## Chat lifecycle

```text
POST /api/conversations                         → { conversation, messages[] }   (greeting included)
GET  /api/conversations/:id                     → { conversation, pendingActions[], turnInProgress }
GET  /api/conversations/:id/messages            → { messages[] }                  (render on load/refresh)
POST /api/conversations/:id/messages {content, async:true}
     → 202 { turnId }                            the agent works in the background
     → 409 TURN_IN_PROGRESS                      disable the input while a turn runs
GET  /api/events?conversationId=:id             SSE stream (EventSource), supports Last-Event-ID
```

Recommended client loop:
1. Open `new EventSource(`${API}/api/events?conversationId=${id}`)` once per conversation.
2. On send: append the user's message optimistically, `POST … {content, async: true}`, show a typing indicator.
3. `agent.status` events drive the indicator (`phase: started | thinking | tool | done`, `label`, e.g.
   "Drafting personalised outreach emails").
4. On `message.created` (or `agent.status` with `phase: done`), refetch `/messages` (or the new message by id).
5. SSE is only a hint. The source of truth is always REST, so reconnects and refreshes never lose anything.

## Cards

Each assistant message has `cards: Card[]` (`{ type, payload, pendingActionId? }`). Proposal cards carry a
`pendingActionId`. The card buttons call:

```text
PATCH /api/actions/:id {payload}       edit (full payload re-validated; 400 shows field errors)
POST  /api/actions/:id/confirm {payload?}   commit (optionally with final edits)
POST  /api/actions/:id/cancel
GET   /api/actions/:id                 current status: pending | confirmed | cancelled | superseded | failed
```

A `400` on confirm means "fix and retry": the card stays `pending`, and `error.details.guardrails` lists
outbound-email findings to highlight. `409 NOT_PENDING` means it was already handled; refetch.

| Card type | Proposal? | Payload highlights | Live data to fetch |
|---|---|---|---|
| `JOB_CONFIRM` | yes (`CREATE_JOB`) | `draft` (editable), `display.guardrails` (fair-hiring warnings) | |
| `SOURCING_CONFIRM` | yes (`START_SOURCING`) | `useWebSearch`, `query`, `maxResults`, `csvUploadIds`, `includeTalentPool`, `display.talentPool[]` | upload CSV: `POST /api/jobs/:id/candidates/upload` (multipart `file`, `conversationId`) |
| `SOURCING_PROGRESS` | no | `runId`, `jobId` | `GET /api/sourcing-runs/:runId`, SSE `sourcing.progress` |
| `CANDIDATE_TABLE` | no | `jobId`, `filter`, `view` | `GET /api/jobs/:id/candidates?status=&minScore=&search=&sort=` |
| `REVIEW_CONFIRM` | yes (`REVIEW_DECISIONS`) | `decisions[]`, `display.problems[]` | |
| `CAMPAIGN_PREVIEW` | yes (`CREATE_CAMPAIGN`) | `steps[]`, `recipients[].drafts[]` (editable), `dailyLimit`, `excluded[]`, `display.guardrails{candidateId: findings[]}` | live check while editing: `POST /api/guardrails/check {mode:'email'}` |
| `CAMPAIGN_PROGRESS` | no | `campaignId` | `GET /api/campaigns/:id`, SSE `campaign.progress`, pause/resume endpoints |
| `REPLY_REVIEW` | yes (`SEND_REPLY`) or `autoSent: true` | `subject`, `body` (editable), `display.{classification, confidence, original, injectionFlag, priority, urgencySignals, bookingUrl, guardrails}` | |
| `STATUS_UPDATE` | yes (`STATUS_CHANGE`) | `to`, `changes[]`, `display.illegal[]` | |
| `CAMPAIGN_CONTROL` / `SETTINGS_CONFIRM` / `CANDIDATE_UPDATE` | yes | small payloads | |
| `STATS_SUMMARY` | no | `jobId` | `GET /api/jobs/:id/stats`, `GET /api/jobs/:id/summary` |
| `TALENT_POOL` | no | `matches[]` (name, fromJobTitle, similarity) | `GET /api/jobs/:id/talent-pool` |
| `GUARDRAIL` | no | `rail`, `verdict`, `findings[]` | |
| `ACTION_RESULT` | no | `kind` + result details | |

## Direct UI actions (a click is the approval)

```text
POST  /api/candidates/decisions {jobId, decisions:[{candidateId, decision:'accept'|'reject'}]}
POST  /api/candidates/:id/status {to}          409 ILLEGAL_TRANSITION → show error.message
PATCH /api/candidates/:id {email}              manual enrichment
PATCH /api/jobs/:id/settings {autoReply}
POST  /api/campaigns/:id/pause | /resume
POST  /simulate-reply {candidateId|email, body} "Simulate reply" drawer
GET/POST /api/booking/:token                   the /booking/:token page
```

## SSE events

`message.created`, `agent.status`, `action.updated`, `job.updated`, `sourcing.progress`, `sourcing.done`,
`campaign.progress`, `reply.received`, `reply.processed`, `state_sync {candidateIds, reason}`,
`usage.updated {usage}`, `activity.created`, `guardrail.triggered`. Each event is
`{ id, name, conversationId, jobId, data, at }`. Invalidate the matching TanStack Query keys on `state_sync`.

## Errors

Always `{"error": {"code", "message", "details?"}}`. Show `message` to the recruiter; it is written for humans.
