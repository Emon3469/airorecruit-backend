/**
 * Chat card contract shared with the frontend. A chat message can carry cards;
 * the React client renders each `type` with a dedicated interactive component.
 *
 * Live cards (SOURCING_PROGRESS, CANDIDATE_TABLE, CAMPAIGN_PROGRESS, STATS_SUMMARY) store
 * only references (jobId/runId/campaignId). The client fetches live data and refreshes
 * on SSE `state_sync`, so a page refresh never shows stale numbers.
 */
export const CARD_TYPES = [
  'JOB_CONFIRM',
  'SOURCING_CONFIRM',
  'SOURCING_PROGRESS',
  'CANDIDATE_TABLE',
  'REVIEW_CONFIRM',
  'CAMPAIGN_PREVIEW',
  'CAMPAIGN_PROGRESS',
  'REPLY_REVIEW',
  'STATUS_UPDATE',
  'STATS_SUMMARY',
  'CAMPAIGN_CONTROL',
  'SETTINGS_CONFIRM',
  'ACTION_RESULT',
  'GUARDRAIL',
  'CANDIDATE_UPDATE',
  'TALENT_POOL',
] as const;

export type CardType = (typeof CARD_TYPES)[number];

export interface Card {
  type: CardType;
  /** Present on proposal cards; the card's Confirm/Cancel/Edit buttons call /api/actions/:id/*. */
  pendingActionId?: string;
  payload: Record<string, unknown>;
}

/** Pending action (proposal) types. Each has exactly one commit handler. */
export const ACTION_TYPES = [
  'CREATE_JOB',
  'START_SOURCING',
  'REVIEW_DECISIONS',
  'CREATE_CAMPAIGN',
  'STATUS_CHANGE',
  'SEND_REPLY',
  'CAMPAIGN_CONTROL',
  'UPDATE_JOB_SETTINGS',
  'UPDATE_CANDIDATE_EMAIL',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_CARD: Record<ActionType, CardType> = {
  CREATE_JOB: 'JOB_CONFIRM',
  START_SOURCING: 'SOURCING_CONFIRM',
  REVIEW_DECISIONS: 'REVIEW_CONFIRM',
  CREATE_CAMPAIGN: 'CAMPAIGN_PREVIEW',
  STATUS_CHANGE: 'STATUS_UPDATE',
  SEND_REPLY: 'REPLY_REVIEW',
  CAMPAIGN_CONTROL: 'CAMPAIGN_CONTROL',
  UPDATE_JOB_SETTINGS: 'SETTINGS_CONFIRM',
  UPDATE_CANDIDATE_EMAIL: 'CANDIDATE_UPDATE',
};

export type Actor = 'user_ui' | 'user_chat' | 'agent' | 'worker' | 'system' | 'candidate';
