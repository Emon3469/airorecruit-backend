import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Booking, Candidate, Job } from '../models';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { transition } from './pipeline.service';
import { logActivity } from './activity.service';
import { appendMessage } from './chat.service';
import { publish } from './events';

/**
 * Mock time-slot picker (stands in for Calendly). Links use an unguessable random token,
 * never the candidate id. Status becomes "Meeting booked" when the candidate picks a slot.
 */
export function proposeSlots(from = new Date()): Date[] {
  const slots: Date[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (slots.length < 6) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const hour of [10, 15]) slots.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0)));
  }
  return slots;
}

export async function createBooking(jobId: Types.ObjectId | string, candidateId: Types.ObjectId | string) {
  const existing = await Booking.findOne({ jobId, candidateId, chosenSlot: null });
  if (existing) return existing;
  return Booking.create({ token: crypto.randomBytes(18).toString('base64url'), jobId, candidateId, slots: proposeSlots() });
}

export function bookingUrl(token: string) {
  return `${env.PUBLIC_BOOKING_BASE_URL.replace(/\/$/, '')}/${token}`;
}

export async function getBookingView(token: string) {
  const b = await Booking.findOne({ token });
  if (!b) throw new NotFoundError('Booking link');
  const [cand, job] = await Promise.all([Candidate.findById(b.candidateId), Job.findById(b.jobId)]);
  return {
    token: b.token,
    candidateFirstName: cand?.name.split(' ')[0] ?? 'there',
    jobTitle: job?.title ?? 'the role',
    company: job?.company ?? null,
    slots: (b.slots as unknown as Date[]).map((s) => s.toISOString()),
    chosenSlot: b.chosenSlot?.toISOString() ?? null,
  };
}

export async function chooseSlot(token: string, slotIso: string) {
  const slot = new Date(slotIso);
  if (Number.isNaN(slot.getTime())) throw new ValidationError('Invalid slot');
  const b = await Booking.findOne({ token });
  if (!b) throw new NotFoundError('Booking link');
  if (!(b.slots as unknown as Date[]).some((s) => s.getTime() === slot.getTime())) throw new ValidationError('That slot is not available');
  const updated = await Booking.findOneAndUpdate({ _id: b._id, chosenSlot: null }, { $set: { chosenSlot: slot, bookedAt: new Date() } }, { new: true });
  if (!updated) throw new ConflictError('ALREADY_BOOKED', 'A slot has already been booked with this link.');

  const cand = await Candidate.findById(b.candidateId);
  if (cand && cand.status !== 'MeetingBooked') {
    try {
      await transition(cand._id, 'MeetingBooked', { actor: 'candidate', reason: `Booked ${slot.toISOString()}` });
    } catch (err) {
      await logActivity({ jobId: b.jobId, candidateId: b.candidateId, actor: 'candidate', action: 'booking_conflict', message: (err as Error).message });
    }
  }
  await logActivity({
    jobId: b.jobId,
    candidateId: b.candidateId,
    candidateName: cand?.name ?? null,
    actor: 'candidate',
    action: 'meeting_booked',
    message: `Meeting booked for ${slot.toUTCString()}`,
  });
  const job = await Job.findById(b.jobId);
  if (job?.conversationId) {
    await appendMessage(job.conversationId, {
      role: 'assistant',
      jobId: job._id,
      content: `${cand?.name ?? 'A candidate'} booked a meeting for ${slot.toUTCString()} and is now in Meeting booked. After the interview, tell me "mark ${cand?.name.split(' ')[0] ?? 'them'} as interviewed".`,
      cards: cand ? [{ type: 'ACTION_RESULT', payload: { kind: 'meeting_booked', candidateId: String(cand._id), name: cand.name, slot: slot.toISOString() } }] : [],
    });
  }
  await publish('state_sync', { reason: 'meeting_booked', candidateIds: [String(b.candidateId)] }, { jobId: b.jobId });
  return getBookingView(token);
}
