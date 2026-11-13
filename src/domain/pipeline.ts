/**
 * Candidate pipeline state machine (pure, no I/O, fully unit tested).
 *
 *   Sourced → Accepted / Rejected → Contacted → Replied → Interested / NotInterested
 *   → MeetingBooked → Interviewed → Shortlisted → Hired / Rejected
 *   Unsubscribed is reachable from any state after Contacted and stops all outreach.
 *
 * The brief lists "Rejected" twice (at review and at the end). We keep ONE status
 * plus `rejectedStage: 'review' | 'final'`, so the funnel can tell them apart.
 */
export const CANDIDATE_STATUSES = [
  'Sourced',
  'Accepted',
  'Rejected',
  'Contacted',
  'Replied',
  'Interested',
  'NotInterested',
  'MeetingBooked',
  'Interviewed',
  'Shortlisted',
  'Hired',
  'Unsubscribed',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type RejectedStage = 'review' | 'final';

export const STATUS_LABELS: Record<CandidateStatus, string> = {
  Sourced: 'Sourced',
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Contacted: 'Contacted',
  Replied: 'Replied',
  Interested: 'Interested',
  NotInterested: 'Not interested',
  MeetingBooked: 'Meeting booked',
  Interviewed: 'Interviewed',
  Shortlisted: 'Shortlisted',
  Hired: 'Hired',
  Unsubscribed: 'Unsubscribed',
};

/** States after first contact: Unsubscribed is allowed from all of these. */
export const POST_CONTACT: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  'Contacted',
  'Replied',
  'Interested',
  'NotInterested',
  'MeetingBooked',
  'Interviewed',
  'Shortlisted',
]);

/** States in which automated follow-ups must never be sent. */
export const OUTREACH_BLOCKING: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  'Replied',
  'Interested',
  'NotInterested',
  'MeetingBooked',
  'Interviewed',
  'Shortlisted',
  'Hired',
  'Unsubscribed',
  'Rejected',
]);

type StateKey = CandidateStatus | 'Rejected:review' | 'Rejected:final';

const TRANSITIONS: Record<StateKey, readonly StateKey[]> = {
  Sourced: ['Accepted', 'Rejected:review'],
  'Rejected:review': ['Accepted'], // undo a review rejection
  Rejected: ['Accepted'],
  Accepted: ['Contacted', 'Rejected:review'],
  Contacted: ['Replied'],
  Replied: ['Interested', 'NotInterested', 'MeetingBooked', 'Rejected:final'],
  Interested: ['MeetingBooked', 'NotInterested', 'Rejected:final'],
  NotInterested: ['Interested'], // a candidate can change their mind
  MeetingBooked: ['Interviewed', 'Rejected:final'],
  Interviewed: ['Shortlisted', 'Rejected:final'],
  Shortlisted: ['Hired', 'Rejected:final'],
  'Rejected:final': [],
  Hired: [],
  Unsubscribed: [],
};

function keyOf(status: CandidateStatus, rejectedStage?: RejectedStage | null): StateKey {
  if (status === 'Rejected') return rejectedStage === 'final' ? 'Rejected:final' : 'Rejected:review';
  return status;
}

export interface TransitionTarget {
  status: CandidateStatus;
  rejectedStage?: RejectedStage;
}

/**
 * Resolve a requested target status into a concrete transition, or null if illegal.
 * "Rejected" is interpreted contextually: before contact it is a review rejection,
 * after an interview stage it is a final rejection.
 */
export function resolveTransition(
  from: CandidateStatus,
  fromRejectedStage: RejectedStage | null | undefined,
  to: CandidateStatus,
): TransitionTarget | null {
  if (from === to) return null;
  if (to === 'Unsubscribed') return POST_CONTACT.has(from) ? { status: 'Unsubscribed' } : null;

  const allowed = TRANSITIONS[keyOf(from, fromRejectedStage)];
  if (to === 'Rejected') {
    if (allowed.includes('Rejected:review')) return { status: 'Rejected', rejectedStage: 'review' };
    if (allowed.includes('Rejected:final')) return { status: 'Rejected', rejectedStage: 'final' };
    return null;
  }
  return allowed.includes(to) ? { status: to } : null;
}

export function canTransition(
  from: CandidateStatus,
  to: CandidateStatus,
  fromRejectedStage?: RejectedStage | null,
): boolean {
  return resolveTransition(from, fromRejectedStage, to) !== null;
}

export function allowedNext(from: CandidateStatus, fromRejectedStage?: RejectedStage | null): CandidateStatus[] {
  return CANDIDATE_STATUSES.filter((to) => canTransition(from, to, fromRejectedStage));
}

/** Parse loose user/LLM input ("not interested", "meeting booked", "hire") to a status. */
export function parseStatus(input: string): CandidateStatus | null {
  const s = input.toLowerCase().replace(/[^a-z]/g, '');
  const aliases: Record<string, CandidateStatus> = {
    sourced: 'Sourced',
    accept: 'Accepted',
    accepted: 'Accepted',
    reject: 'Rejected',
    rejected: 'Rejected',
    contacted: 'Contacted',
    replied: 'Replied',
    interested: 'Interested',
    notinterested: 'NotInterested',
    meetingbooked: 'MeetingBooked',
    meeting: 'MeetingBooked',
    booked: 'MeetingBooked',
    interviewed: 'Interviewed',
    interview: 'Interviewed',
    shortlisted: 'Shortlisted',
    shortlist: 'Shortlisted',
    hired: 'Hired',
    hire: 'Hired',
    unsubscribed: 'Unsubscribed',
    unsubscribe: 'Unsubscribed',
  };
  return aliases[s] ?? null;
}

/**
 * Funnel stages, in order. A candidate counts towards every stage it has *reached*
 * (tracked in `milestones`), so a Hired candidate still counts as Contacted/Replied.
 */
export const FUNNEL_STAGES: CandidateStatus[] = [
  'Sourced',
  'Accepted',
  'Contacted',
  'Replied',
  'Interested',
  'MeetingBooked',
  'Interviewed',
  'Shortlisted',
  'Hired',
];
