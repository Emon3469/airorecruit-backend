import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { Job, type JobDoc } from '../models';
import { AppError, NotFoundError, ValidationError } from '../lib/errors';
import { heuristicExtractJob } from '../domain/heuristics';
import { json } from '../llm';
import { JD_EXTRACTION_SYSTEM } from '../llm/prompts';
import { wrapUntrusted } from '../domain/untrusted';
import type { Types } from 'mongoose';

const nullableStr = z.string().trim().max(200).nullable();

/** What the extractor returns, and what the editable JOB_CONFIRM card edits. */
export const JobDraftSchema = z.object({
  title: z.string().trim().min(2).max(140),
  company: nullableStr,
  mustHaveSkills: z.array(z.string().trim().min(1).max(60)).max(20),
  niceToHaveSkills: z.array(z.string().trim().min(1).max(60)).max(20),
  seniority: z.enum(['intern', 'junior', 'mid', 'senior', 'lead', 'principal']).nullable(),
  location: nullableStr,
  salary: z.object({
    raw: nullableStr,
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    currency: z.string().trim().max(10).nullable(),
    period: z.enum(['year', 'month', 'hour']).nullable(),
  }),
  remotePolicy: z.enum(['remote', 'hybrid', 'onsite', 'unspecified']),
  employmentType: nullableStr,
  summary: z.string().trim().max(400).nullable(),
});
export type JobDraft = z.infer<typeof JobDraftSchema>;

export const CreateJobPayloadSchema = z.object({
  draft: JobDraftSchema,
  rawJD: z.string().min(20).max(60_000),
  sourceUrl: z.string().url().nullable(),
});
export type CreateJobPayload = z.infer<typeof CreateJobPayloadSchema>;

/* ------------------------------------------------------------- URL fetching (SSRF-safe) */

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

export async function fetchJobDescription(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('That does not look like a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('Only http(s) links are supported.');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError(422, 'URL_UNREACHABLE', `Could not resolve ${url.hostname}.`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new ValidationError('Links to private or local network addresses are not allowed.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  let html: string;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AiroRecruitBot/1.0)', accept: 'text/html,text/plain' },
    });
    if (!res.ok) throw new AppError(422, 'URL_FETCH_FAILED', `The page returned HTTP ${res.status}. Paste the job description text instead.`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 3_000_000) throw new AppError(422, 'URL_TOO_LARGE', 'That page is too large. Paste the job description text instead.');
    html = new TextDecoder().decode(buf);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(422, 'URL_FETCH_FAILED', 'Could not fetch that page. Paste the job description text instead.');
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, footer, header, iframe, form').remove();
  // Many job boards embed the posting as JSON-LD; prefer it when present.
  let text = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const posting = [data].flat().find((d: { '@type'?: string }) => d?.['@type'] === 'JobPosting');
      if (posting?.description) text = `${posting.title ?? ''}\n${cheerio.load(posting.description).text()}`;
    } catch {
      /* ignore */
    }
  });
  if (!text) {
    const main = $('main, article, [role=main], .job-description, #job-description').first();
    text = (main.length ? main : $('body')).text();
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  if (text.length < 200) {
    throw new AppError(422, 'URL_NO_CONTENT', 'I could not find a job description on that page (it may require JavaScript or a login). Please paste the text instead.');
  }
  return text.slice(0, 40_000);
}

/* ------------------------------------------------------------- Extraction */

export async function extractJobDraft(rawJD: string, ctx: { conversationId?: Types.ObjectId | string }): Promise<JobDraft> {
  const heuristic = heuristicExtractJob(rawJD);
  const draft = await json(
    {
      tier: 'fast',
      system: JD_EXTRACTION_SYSTEM,
      prompt: `Extract the job requirements from this job description.\n\n${wrapUntrusted('job_description', rawJD)}`,
      schema: JobDraftSchema,
      schemaName: 'job_extraction',
      effort: 'low',
      maxTokens: 3000,
      mock: () => ({
        ...heuristic,
        seniority: (heuristic.seniority ?? null) as JobDraft['seniority'],
        salary: { ...heuristic.salary, period: heuristic.salary.period as JobDraft['salary']['period'] },
      }),
    },
    { purpose: 'jd_extraction', conversationId: ctx.conversationId },
  );
  // Dedupe and keep the lists disjoint.
  const must = [...new Set(draft.mustHaveSkills)];
  return { ...draft, mustHaveSkills: must, niceToHaveSkills: [...new Set(draft.niceToHaveSkills)].filter((s) => !must.includes(s)) };
}

/* ------------------------------------------------------------- Commit */

export async function createJob(payload: CreateJobPayload, conversationId: Types.ObjectId | string | null): Promise<JobDoc> {
  const { draft } = payload;
  return Job.create({
    conversationId,
    title: draft.title,
    company: draft.company,
    mustHaveSkills: draft.mustHaveSkills,
    niceToHaveSkills: draft.niceToHaveSkills,
    seniority: draft.seniority,
    location: draft.location,
    salary: draft.salary,
    remotePolicy: draft.remotePolicy,
    employmentType: draft.employmentType,
    summary: draft.summary,
    rawJD: payload.rawJD,
    sourceUrl: payload.sourceUrl,
  });
}

export async function getJob(id: Types.ObjectId | string): Promise<JobDoc> {
  const job = await Job.findById(id);
  if (!job) throw new NotFoundError('Job');
  return job;
}

/** Resolve "the React job", a title fragment, or an id. Returns null when ambiguous/unknown. */
export async function resolveJob(ref: string | null | undefined, fallbackId?: Types.ObjectId | string | null) {
  if (!ref) return fallbackId ? Job.findById(fallbackId) : null;
  if (/^[a-f0-9]{24}$/i.test(ref)) return Job.findById(ref);
  const words = ref
    .toLowerCase()
    .replace(/\b(the|job|role|position|opening)\b/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const jobs = await Job.find({}).sort({ createdAt: -1 }).limit(100);
  const hits = jobs.filter((j) => words.every((w) => `${j.title} ${j.company ?? ''} ${j.mustHaveSkills.join(' ')}`.toLowerCase().includes(w)));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exact = hits.filter((j) => words.every((w) => j.title.toLowerCase().includes(w)));
    if (exact.length === 1) return exact[0];
    // Prefer the active job if it's among the hits, otherwise the most recent.
    return hits.find((j) => fallbackId && String(j._id) === String(fallbackId)) ?? hits[0];
  }
  return fallbackId ? Job.findById(fallbackId) : null;
}

export function jobBrief(job: JobDoc) {
  return {
    id: String(job._id),
    title: job.title,
    company: job.company,
    seniority: job.seniority,
    location: job.location,
    remotePolicy: job.remotePolicy,
    mustHaveSkills: job.mustHaveSkills,
    niceToHaveSkills: job.niceToHaveSkills,
    salary: job.salary?.raw ?? null,
    autoReply: job.settings?.autoReply ?? 'off',
  };
}
