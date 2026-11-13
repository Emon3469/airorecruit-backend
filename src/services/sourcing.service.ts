import { parse } from 'csv-parse/sync';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { Candidate, CsvUpload, Job, SourcingRun, type JobDoc } from '../models';
import { AppError, NotFoundError, isDuplicateKeyError } from '../lib/errors';
import { logger } from '../lib/logger';
import {
  canonicalizeProfileUrl,
  cleanName,
  isLinkedInProfileUrl,
  normalizeEmail,
  parseSerperTitle,
  splitList,
} from '../domain/normalize';
import { scanForInjection } from '../domain/untrusted';
import { logActivity } from './activity.service';
import { publish } from './events';
import { enqueue, jobIds, QUEUE_NAMES } from '../queues/queues';
import { appendMessage } from './chat.service';
import { talentPoolRows } from './talent.service';

/* ------------------------------------------------------------- Types */

export interface SourcedRow {
  name: string;
  email: string | null;
  profileUrl: string | null;
  headline: string | null;
  location: string | null;
  skills: string[];
  yearsExperience: number | null;
  company: string | null;
  snippet: string | null;
  source: 'serper' | 'csv' | 'manual' | 'talent_pool';
  /** Provenance of the email when copied from the talent pool. */
  emailSource?: 'csv' | 'manual' | null;
}

export const StartSourcingPayloadSchema = z.object({
  jobId: z.string(),
  useWebSearch: z.boolean(),
  query: z.string().trim().max(300).nullable(),
  maxResults: z.number().int().min(1).max(100),
  csvUploadIds: z.array(z.string()).max(10),
  /** Rediscover matching candidates from earlier jobs (semantic search over the talent pool). */
  includeTalentPool: z.boolean().default(false),
});
export type StartSourcingPayload = z.input<typeof StartSourcingPayloadSchema>;

/* ------------------------------------------------------------- Web search (Serper) */

/**
 * Build a Google query restricted to public LinkedIn profile pages. We never scrape LinkedIn:
 * only the search result URL, title and snippet are used.
 */
export function buildSearchQuery(job: Pick<JobDoc, 'title' | 'location' | 'mustHaveSkills' | 'remotePolicy'>): string {
  const coreTitle = job.title
    .replace(/\(.*?\)/g, '')
    .replace(/\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|mid[- ]level|remote|hybrid)\b/gi, '')
    .replace(/[-–|,].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Recall matters more than precision here (scoring ranks afterwards): quote only the title, offer an
  // Engineer/Developer variant, add ONE skill not already in the title, and an unquoted city.
  // Live-tested: quoting title + skills + city returned 1 result where this returns a full page.
  const variants = new Set([coreTitle]);
  if (/\bengineer\b/i.test(coreTitle)) variants.add(coreTitle.replace(/\bengineer\b/i, 'Developer'));
  else if (/\bdeveloper\b/i.test(coreTitle)) variants.add(coreTitle.replace(/\bdeveloper\b/i, 'Engineer'));
  const titlePart = coreTitle ? (variants.size > 1 ? `(${[...variants].map((v) => `"${v}"`).join(' OR ')})` : `"${coreTitle}"`) : '';
  const skill = job.mustHaveSkills.find((s) => !coreTitle.toLowerCase().includes(s.toLowerCase())) ?? '';
  const loc = job.location && job.remotePolicy !== 'remote' ? job.location.split(',')[0]!.replace(/\(.*?\)/g, '').trim() : '';
  return ['site:linkedin.com/in', titlePart, skill, loc].filter(Boolean).join(' ');
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

export async function searchSerper(query: string, max: number): Promise<SourcedRow[]> {
  if (!env.SERPER_API_KEY) return [];
  const rows: SourcedRow[] = [];
  const pageSize = 10;
  for (let page = 1; rows.length < max && page <= Math.ceil(max / pageSize); page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let data: { organic?: SerperOrganic[] };
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: pageSize, page }),
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) throw new AppError(502, 'SERPER_AUTH', 'Serper rejected the API key.');
      if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
      data = (await res.json()) as typeof data;
    } finally {
      clearTimeout(timer);
    }
    const organic = data.organic ?? [];
    for (const r of organic) {
      const url = canonicalizeProfileUrl(r.link);
      if (!isLinkedInProfileUrl(url) || !r.title) continue;
      const { name, headline } = parseSerperTitle(r.title);
      if (!name || name.length < 3 || /linkedin/i.test(name)) continue;
      rows.push({
        name,
        headline,
        email: null, // Search results never contain verified emails. We do not guess them.
        profileUrl: r.link ?? url,
        location: null,
        skills: [],
        yearsExperience: null,
        company: null,
        snippet: r.snippet?.slice(0, 600) ?? null,
        source: 'serper',
      });
    }
    if (organic.length < pageSize) break;
  }
  return rows.slice(0, max);
}

/* ------------------------------------------------------------- CSV */

const HEADER_MAP: Record<string, keyof SourcedRow | 'firstName' | 'lastName'> = {
  name: 'name', fullname: 'name', candidate: 'name', candidatename: 'name',
  firstname: 'firstName', first: 'firstName', givenname: 'firstName',
  lastname: 'lastName', last: 'lastName', surname: 'lastName', familyname: 'lastName',
  email: 'email', emailaddress: 'email', mail: 'email', workemail: 'email',
  linkedin: 'profileUrl', linkedinurl: 'profileUrl', profile: 'profileUrl', profileurl: 'profileUrl', url: 'profileUrl', linkedinprofile: 'profileUrl',
  headline: 'headline', title: 'headline', currenttitle: 'headline', jobtitle: 'headline', role: 'headline', position: 'headline',
  location: 'location', city: 'location', country: 'location',
  skills: 'skills', skill: 'skills', techstack: 'skills', stack: 'skills', technologies: 'skills',
  years: 'yearsExperience', yearsexperience: 'yearsExperience', experience: 'yearsExperience', yoe: 'yearsExperience', experienceyears: 'yearsExperience',
  company: 'company', currentcompany: 'company', employer: 'company',
  notes: 'snippet', summary: 'snippet', bio: 'snippet', about: 'snippet', description: 'snippet',
};

export interface CsvParseResult {
  rows: SourcedRow[];
  invalid: { line: number; reason: string }[];
  headers: string[];
}

export function parseCandidateCsv(content: string): CsvParseResult {
  let records: Record<string, string>[];
  try {
    records = parse(content.replace(/^﻿/, ''), {
      columns: (h: string[]) => h.map((x) => x.trim()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      to: 5000,
    });
  } catch (err) {
    throw new AppError(400, 'CSV_PARSE_ERROR', `Could not parse the CSV: ${(err as Error).message}`);
  }
  const headers = records[0] ? Object.keys(records[0]) : [];
  const rows: SourcedRow[] = [];
  const invalid: CsvParseResult['invalid'] = [];
  records.forEach((rec, i) => {
    const line = i + 2; // 1-based + header
    const m: Partial<Record<keyof SourcedRow | 'firstName' | 'lastName', string>> = {};
    for (const [k, v] of Object.entries(rec)) {
      const key = HEADER_MAP[k.toLowerCase().replace(/[^a-z]/g, '')];
      if (key && v && !m[key]) m[key] = String(v);
    }
    const name = cleanName(m.name ?? [m.firstName, m.lastName].filter(Boolean).join(' '));
    const rawEmail = m.email?.trim() || null;
    const email = normalizeEmail(rawEmail);
    const profileUrl = m.profileUrl?.trim() || null;
    if (!name) return invalid.push({ line, reason: 'missing name' });
    if (rawEmail && !email) return invalid.push({ line, reason: `invalid email "${rawEmail.slice(0, 60)}"` });
    if (!email && !canonicalizeProfileUrl(profileUrl)) return invalid.push({ line, reason: 'needs an email or a profile URL' });
    const years = m.yearsExperience ? parseFloat(m.yearsExperience) : NaN;
    rows.push({
      name,
      email,
      profileUrl,
      headline: m.headline?.slice(0, 200) ?? null,
      location: m.location?.slice(0, 120) ?? null,
      skills: splitList(m.skills),
      yearsExperience: Number.isFinite(years) && years >= 0 && years < 60 ? years : null,
      company: m.company?.slice(0, 120) ?? null,
      snippet: m.snippet?.slice(0, 1000) ?? null,
      source: 'csv',
    });
  });
  return { rows, invalid, headers };
}

export async function storeCsvUpload(jobId: string, filename: string, content: string) {
  const job = await Job.findById(jobId);
  if (!job) throw new NotFoundError('Job');
  const parsed = parseCandidateCsv(content);
  if (!parsed.rows.length) {
    throw new AppError(400, 'CSV_EMPTY', `No valid candidate rows found. ${parsed.invalid.slice(0, 3).map((r) => `Line ${r.line}: ${r.reason}`).join('; ')}`);
  }
  const upload = await CsvUpload.create({
    jobId,
    filename,
    rows: parsed.rows,
    rowCount: parsed.rows.length,
    invalidRows: parsed.invalid,
  });
  return { upload, parsed };
}

/* ------------------------------------------------------------- Import + dedupe */

export interface ImportStats {
  created: number;
  duplicates: number;
  enriched: number;
  createdIds: Types.ObjectId[];
  rescoreIds: Types.ObjectId[];
}

/**
 * Insert or merge candidates. Dedupe key = normalized email OR canonical profile URL (per job),
 * backed by unique partial indexes so concurrent imports cannot create duplicates either.
 * Merging only fills fields that are empty; it never overwrites existing data.
 */
export async function importRows(jobId: Types.ObjectId, rows: SourcedRow[]): Promise<ImportStats> {
  const stats: ImportStats = { created: 0, duplicates: 0, enriched: 0, createdIds: [], rescoreIds: [] };
  for (const row of rows) {
    const emailLower = normalizeEmail(row.email);
    const canonical = canonicalizeProfileUrl(row.profileUrl);
    const or: Record<string, unknown>[] = [];
    if (emailLower) or.push({ emailLower });
    if (canonical) or.push({ profileUrlCanonical: canonical });
    if (!or.length) continue;

    const existing = await Candidate.findOne({ jobId, $or: or });
    if (existing) {
      stats.duplicates++;
      const set: Record<string, unknown> = {};
      let rescore = false;
      if (!existing.email && emailLower) {
        set.email = emailLower;
        set.emailLower = emailLower;
        set.emailSource = row.source === 'csv' ? 'csv' : 'manual';
        set.missingData = existing.missingData.filter((m) => m !== 'email');
      }
      if (!existing.profileUrlCanonical && canonical) {
        set.profileUrl = row.profileUrl;
        set.profileUrlCanonical = canonical;
      }
      if (!existing.headline && row.headline) set.headline = row.headline;
      if (!existing.location && row.location) (set.location = row.location), (rescore = true);
      if (existing.yearsExperience === null && row.yearsExperience !== null) (set.yearsExperience = row.yearsExperience), (rescore = true);
      if (!existing.currentCompany && row.company) set.currentCompany = row.company;
      const newSkills = row.skills.filter((s) => !existing.skills.some((e) => e.toLowerCase() === s.toLowerCase()));
      if (newSkills.length) (set.skills = [...existing.skills, ...newSkills]), (rescore = true);
      if (Object.keys(set).length) {
        try {
          await Candidate.updateOne({ _id: existing._id }, { $set: set, $addToSet: { sources: row.source } });
          if (set.email) stats.enriched++;
          if (rescore && existing.status === 'Sourced') stats.rescoreIds.push(existing._id);
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err; // email/URL belongs to another record: keep both untouched
        }
      }
      continue;
    }

    const scan = scanForInjection([row.headline, row.snippet, row.skills.join(' ')].join(' '));
    try {
      const doc = await Candidate.create({
        jobId,
        name: row.name,
        headline: row.headline,
        location: row.location,
        currentCompany: row.company,
        yearsExperience: row.yearsExperience,
        skills: row.skills,
        profileUrl: row.profileUrl,
        profileUrlCanonical: canonical ?? undefined,
        email: emailLower,
        emailLower: emailLower ?? undefined,
        emailSource: emailLower ? (row.emailSource ?? (row.source === 'csv' ? 'csv' : 'manual')) : null,
        source: row.source,
        sources: [row.source],
        snippet: row.snippet,
        injectionFlag: scan.flagged,
        missingData: emailLower ? [] : ['email'],
      });
      stats.created++;
      stats.createdIds.push(doc._id);
    } catch (err) {
      if (isDuplicateKeyError(err)) stats.duplicates++; // lost a race with a concurrent import
      else throw err;
    }
  }
  return stats;
}

/* ------------------------------------------------------------- Run orchestration */

export async function startSourcing(payload: StartSourcingPayload, conversationId: Types.ObjectId | string | null) {
  const job = await Job.findById(payload.jobId);
  if (!job) throw new NotFoundError('Job');
  const run = await SourcingRun.create({
    jobId: job._id,
    conversationId,
    query: payload.useWebSearch ? payload.query || buildSearchQuery(job) : null,
    useWebSearch: payload.useWebSearch,
    includeTalentPool: payload.includeTalentPool ?? false,
    maxResults: payload.maxResults,
    csvUploadIds: payload.csvUploadIds,
  });
  await enqueue(QUEUE_NAMES.sourcing, 'source', { runId: String(run._id) }, { jobId: jobIds.sourcing(String(run._id)) });
  await logActivity({
    jobId: job._id,
    actor: 'system',
    action: 'sourcing_started',
    meta: { runId: String(run._id), query: run.query, csvUploads: payload.csvUploadIds.length },
  });
  return run;
}

async function progress(runId: Types.ObjectId | string) {
  const run = await SourcingRun.findById(runId).lean();
  if (!run) return;
  await publish(
    'sourcing.progress',
    {
      runId: String(run._id),
      phase: run.status,
      found: run.found,
      created: run.created,
      duplicates: run.duplicates,
      enriched: run.enriched,
      invalid: run.invalid,
      scored: run.scored,
      scoreFailed: run.scoreFailed,
      total: run.total,
    },
    { jobId: run.jobId, conversationId: run.conversationId },
  );
}

/** Sourcing worker body. Idempotent enough to retry: dedupe makes re-imports no-ops. */
export async function runSourcing(runId: string): Promise<void> {
  const run = await SourcingRun.findById(runId);
  if (!run) throw new NotFoundError('SourcingRun');
  if (run.status === 'completed' || run.status === 'scoring') return; // already past the import phase
  const job = await Job.findById(run.jobId);
  if (!job) throw new NotFoundError('Job');

  const notes: string[] = [];
  let webRows: SourcedRow[] = [];
  run.status = 'searching';
  await run.save();
  await progress(run._id);

  if (run.useWebSearch) {
    if (!env.SERPER_API_KEY) {
      notes.push('Web search skipped: SERPER_API_KEY is not configured. CSV import still works.');
    } else {
      try {
        webRows = await searchSerper(run.query ?? buildSearchQuery(job), run.maxResults);
        if (!webRows.length) notes.push('Web search returned no public LinkedIn profiles for this query.');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'serper search failed');
        if (err instanceof AppError) notes.push(err.message);
        else throw err; // transient: let BullMQ retry
      }
    }
  }

  let poolRows: SourcedRow[] = [];
  if (run.includeTalentPool) {
    try {
      poolRows = await talentPoolRows(String(job._id), run.maxResults);
      notes.push(poolRows.length ? `Rediscovered ${poolRows.length} matching candidate(s) from earlier jobs (talent pool).` : 'No strong matches in the talent pool from earlier jobs.');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'talent pool search failed');
      notes.push('Talent pool search was unavailable; continuing without it.');
    }
  }

  run.status = 'importing';
  run.webFound = webRows.length;
  run.poolFound = poolRows.length;
  await run.save();
  await progress(run._id);

  const uploads = await CsvUpload.find({ _id: { $in: run.csvUploadIds }, jobId: job._id });
  const csvRows = uploads.flatMap((u) => u.rows as SourcedRow[]);
  const invalid = uploads.reduce((n, u) => n + (u.invalidRows?.length ?? 0), 0);

  const stats = await importRows(job._id, [...webRows, ...poolRows, ...csvRows]);
  await CsvUpload.updateMany({ _id: { $in: uploads.map((u) => u._id) } }, { $set: { status: 'imported' } });

  const toScore = [...stats.createdIds, ...stats.rescoreIds];
  run.csvRows = csvRows.length;
  run.found = webRows.length + poolRows.length + csvRows.length;
  run.created = stats.created;
  run.duplicates = stats.duplicates;
  run.enriched = stats.enriched;
  run.invalid = invalid;
  run.total = toScore.length;
  run.candidateIds = toScore;
  run.notes = notes;
  run.status = 'scoring';
  await run.save();
  await progress(run._id);

  await logActivity({
    jobId: job._id,
    actor: 'worker',
    action: 'candidates_imported',
    message: `Found ${run.found}, added ${stats.created}, ${stats.duplicates} duplicates merged${stats.enriched ? `, ${stats.enriched} enriched with email` : ''}${invalid ? `, ${invalid} invalid CSV rows` : ''}.`,
    meta: { runId, ...stats, createdIds: undefined, rescoreIds: undefined },
  });

  if (!toScore.length) {
    await finalizeRun(String(run._id));
    return;
  }
  for (const id of toScore) {
    await enqueue(QUEUE_NAMES.scoring, 'score', { candidateId: String(id), runId: String(run._id) }, { jobId: jobIds.scoring(String(id), String(run._id)) });
  }
}

/** Called by the scoring worker after each candidate (success or permanent failure). */
export async function recordScoreProgress(runId: string, ok: boolean): Promise<void> {
  const run = await SourcingRun.findByIdAndUpdate(runId, { $inc: ok ? { scored: 1 } : { scoreFailed: 1 } }, { new: true });
  if (!run) return;
  await progress(run._id);
  if (run.scored + run.scoreFailed >= run.total) await finalizeRun(runId);
}

export async function finalizeRun(runId: string): Promise<void> {
  // Atomic: only one caller transitions the run to completed (and posts the table card).
  const run = await SourcingRun.findOneAndUpdate(
    { _id: runId, status: { $in: ['scoring', 'importing'] } },
    { $set: { status: 'completed', completedAt: new Date() } },
    { new: true },
  );
  if (!run) return;
  await progress(run._id);
  const job = await Job.findById(run.jobId);
  const parts = [
    `Sourcing finished for ${job?.title ?? 'the job'}: found ${run.found}, added ${run.created} new candidate${run.created === 1 ? '' : 's'}`,
    run.duplicates ? `${run.duplicates} duplicate${run.duplicates === 1 ? '' : 's'} merged` : null,
    run.enriched ? `${run.enriched} enriched with an email` : null,
    run.invalid ? `${run.invalid} invalid CSV row${run.invalid === 1 ? '' : 's'} skipped` : null,
    run.scoreFailed ? `${run.scoreFailed} could not be scored` : null,
  ].filter(Boolean);
  const notes = run.notes.length ? `\n${run.notes.join('\n')}` : '';
  const content = `${parts.join(', ')}.${notes}\nReview the ranked candidates below: accept or reject with the buttons, or tell me (e.g. "accept the top 5").`;
  if (run.conversationId) {
    const msg = await appendMessage(run.conversationId, {
      role: 'assistant',
      content,
      jobId: run.jobId,
      cards: [{ type: 'CANDIDATE_TABLE', payload: { jobId: String(run.jobId), runId: String(run._id), view: 'review' } }],
    });
    await publish('sourcing.done', { runId: String(run._id), messageId: String(msg._id) }, { jobId: run.jobId, conversationId: run.conversationId });
  } else {
    await publish('sourcing.done', { runId: String(run._id) }, { jobId: run.jobId });
  }
  await publish('state_sync', { reason: 'sourcing_done' }, { jobId: run.jobId });
}
