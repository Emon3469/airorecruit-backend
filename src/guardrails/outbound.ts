import { env } from '../config/env';
import { extractUrls } from '../domain/untrusted';
import { detectPii, maskValue } from './pii';
import { scanFairness } from './fairness';
import { worst, type Finding, type Verdict } from './types';

/**
 * Outbound-email rail (the notebook's output rail + fact-check rail, applied where it matters most:
 * an email is irreversible once sent). Runs at proposal time (findings shown on the card) and again
 * at commit time and before any auto-send (a `block` finding stops the send).
 */
export interface OutboundInput {
  subject: string;
  body: string;
  recipientEmail?: string | null;
  /** Links that may appear (e.g. our booking link). Everything else is blocked. */
  allowedLinks?: string[];
  /** Trusted job facts used for fact-checking compensation and similar claims. */
  job?: { salaryRaw?: string | null; title?: string; company?: string | null };
}

const ALLOWED_PLACEHOLDERS = new Set(['senderName', 'firstName']);
const PROMISES = /\b(?:guarantee[ds]?|you(?:'re| are) hired|job offer|offer letter|you have the job|100% (?:remote|chance)|promise you)\b/i;
const MONEY = /(?:[$€£৳]|\b(?:usd|eur|gbp|bdt|tk|taka)\b)\s?\d[\d,.]*\s?k?|\b\d[\d,.]*\s?k?\s?(?:usd|eur|gbp|bdt|dollars|euros|taka)\b|\b\d{2,3}\s?k\b/gi;

function digitsIn(s: string): string[] {
  return (s.match(/\d[\d,.]*/g) ?? []).map((d) => d.replace(/[,.]/g, ''));
}

export function checkOutboundEmail(input: OutboundInput): { verdict: Verdict; findings: Finding[] } {
  const findings: Finding[] = [];
  const text = `${input.subject}\n${input.body}`;

  if (!input.subject.trim() || input.body.trim().length < 20) {
    findings.push({ rail: 'outbound', verdict: 'block', reason: 'Subject or body is empty/too short.' });
  }

  // Unresolved template placeholders ({{company}}, [Name], <first name>).
  const bad = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !ALLOWED_PLACEHOLDERS.has(k));
  const bracket = text.match(/\[(?:name|first name|company|candidate|insert[^\]]*|your name|link)\]|<(?:name|first name|company)>/gi) ?? [];
  if (bad.length || bracket.length) {
    findings.push({ rail: 'outbound', verdict: 'block', reason: 'Unfilled placeholder(s) would be sent to the candidate.', matches: [...bad.map((b) => `{{${b}}}`), ...bracket] });
  }

  // Secrets / other people's contact details.
  const allowedEmails = new Set(
    [input.recipientEmail, env.MAIL_FROM.match(/<([^>]+)>/)?.[1], 'unsubscribe@airorecruit.dev'].filter(Boolean).map((e) => e!.toLowerCase()),
  );
  for (const h of detectPii(text)) {
    if (h.secret) findings.push({ rail: 'outbound', verdict: 'block', reason: `Contains a secret/sensitive identifier (${h.type}).`, matches: [maskValue(h.type, h.value)] });
    else if (h.type === 'email' && !allowedEmails.has(h.value.toLowerCase()))
      findings.push({ rail: 'outbound', verdict: 'block', reason: 'Contains an email address other than the recipient\'s (possible data leak).', matches: [maskValue('email', h.value)] });
  }

  // Links: only explicitly allowed ones.
  const allowed = new Set((input.allowedLinks ?? []).map((l) => l.replace(/[.,)]+$/, '')));
  const links = extractUrls(text).map((u) => u.replace(/[.,)]+$/, ''));
  const foreign = links.filter((l) => !allowed.has(l));
  if (foreign.length) findings.push({ rail: 'outbound', verdict: 'block', reason: 'Contains links that were not approved (only the booking link is allowed).', matches: foreign.slice(0, 5) });

  // Fair-hiring language.
  for (const f of scanFairness(text, 'email').findings) findings.push({ ...f, rail: 'fairness' });

  // Fact-check: compensation figures must come from the job description.
  const money = text.match(MONEY) ?? [];
  if (money.length) {
    const jdDigits = new Set(digitsIn(input.job?.salaryRaw ?? ''));
    const unverified = money.filter((m) => digitsIn(m).some((d) => !jdDigits.has(d)));
    if (unverified.length)
      findings.push({ rail: 'outbound', verdict: 'warn', reason: 'Mentions compensation that is not in the job description (unverified claim).', matches: unverified.slice(0, 3) });
  }
  if (PROMISES.test(text)) findings.push({ rail: 'outbound', verdict: 'warn', reason: 'Contains a promise or commitment (offer/guarantee) that the recruiter should double-check.', matches: [text.match(PROMISES)![0]] });

  const words = input.body.split(/\s+/).length;
  if (words > 250) findings.push({ rail: 'outbound', verdict: 'warn', reason: `Long email (${words} words); outreach performs better under ~150 words.` });
  if (/[A-Z]{12,}/.test(input.body.replace(/https?:\/\/\S+/g, ''))) findings.push({ rail: 'outbound', verdict: 'warn', reason: 'Contains SHOUTING (long all-caps text).' });

  return { verdict: worst(findings), findings };
}
