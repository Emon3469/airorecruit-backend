import { describe, expect, it } from 'vitest';
import { CANDIDATE_STATUSES, allowedNext, canTransition, parseStatus, resolveTransition, type CandidateStatus } from '../../src/domain/pipeline';

describe('pipeline state machine', () => {
  const legal: [CandidateStatus, CandidateStatus][] = [
    ['Sourced', 'Accepted'],
    ['Sourced', 'Rejected'],
    ['Accepted', 'Contacted'],
    ['Accepted', 'Rejected'],
    ['Contacted', 'Replied'],
    ['Replied', 'Interested'],
    ['Replied', 'NotInterested'],
    ['Interested', 'MeetingBooked'],
    ['MeetingBooked', 'Interviewed'],
    ['Interviewed', 'Shortlisted'],
    ['Shortlisted', 'Hired'],
    ['Shortlisted', 'Rejected'],
  ];
  it.each(legal)('allows %s → %s', (from, to) => expect(canTransition(from, to)).toBe(true));

  const illegal: [CandidateStatus, CandidateStatus][] = [
    ['Sourced', 'Contacted'],
    ['Sourced', 'Hired'],
    ['Accepted', 'Replied'],
    ['Contacted', 'Hired'],
    ['Hired', 'Rejected'],
    ['Hired', 'Unsubscribed'],
    ['Unsubscribed', 'Interested'],
    ['Interviewed', 'Hired'], // must be shortlisted first
  ];
  it.each(illegal)('rejects %s → %s', (from, to) => expect(canTransition(from, to)).toBe(false));

  it('Unsubscribed is reachable from every post-contact state and nowhere before', () => {
    for (const s of ['Contacted', 'Replied', 'Interested', 'NotInterested', 'MeetingBooked', 'Interviewed', 'Shortlisted'] as CandidateStatus[]) {
      expect(canTransition(s, 'Unsubscribed')).toBe(true);
    }
    for (const s of ['Sourced', 'Accepted', 'Rejected', 'Hired'] as CandidateStatus[]) {
      expect(canTransition(s, 'Unsubscribed')).toBe(false);
    }
  });

  it('interprets Rejected contextually (review vs final)', () => {
    expect(resolveTransition('Sourced', null, 'Rejected')).toEqual({ status: 'Rejected', rejectedStage: 'review' });
    expect(resolveTransition('Interviewed', null, 'Rejected')).toEqual({ status: 'Rejected', rejectedStage: 'final' });
  });

  it('a review rejection can be undone but a final rejection cannot', () => {
    expect(canTransition('Rejected', 'Accepted', 'review')).toBe(true);
    expect(canTransition('Rejected', 'Accepted', 'final')).toBe(false);
  });

  it('terminal states have no next states', () => {
    expect(allowedNext('Hired')).toEqual([]);
    expect(allowedNext('Unsubscribed')).toEqual([]);
  });

  it('parses loose status names', () => {
    expect(parseStatus('hired')).toBe('Hired');
    expect(parseStatus('Not interested')).toBe('NotInterested');
    expect(parseStatus('meeting booked')).toBe('MeetingBooked');
    expect(parseStatus('shortlist')).toBe('Shortlisted');
    expect(parseStatus('banana')).toBeNull();
  });

  it('covers all 12 statuses', () => expect(CANDIDATE_STATUSES).toHaveLength(12));
});
