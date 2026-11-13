import type { Finding } from './types';

/**
 * PII / secret detection and redaction (port of the notebook's `detect_pii_in_input` action, extended).
 *
 * Recruiting is a PII business: candidate emails and phone numbers are legitimate working data, so
 * they are *detected* (and masked where the model doesn't need them) but not blocked. Secrets and
 * high-risk identifiers (API keys, passwords, card numbers, SSNs, IBANs) are never stored or sent to
 * an LLM: they are redacted and the message is blocked with an explanation.
 */

interface Pattern {
  type: string;
  re: RegExp;
  secret: boolean;
  validate?: (m: string) => boolean;
}

function luhn(num: string): boolean {
  const d = num.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const PATTERNS: Pattern[] = [
  // Secrets / credentials
  { type: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, secret: true },
  { type: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, secret: true },
  { type: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, secret: true },
  { type: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, secret: true },
  { type: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, secret: true },
  { type: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, secret: true },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, secret: true },
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, secret: true },
  { type: 'connection_string', re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|rediss|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, secret: true },
  { type: 'generic_secret', re: /\b(?:api[_\s-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/gi, secret: true },
  // High-risk identifiers
  { type: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g, secret: true, validate: luhn },
  { type: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, secret: true },
  { type: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, secret: true },
  // Working PII (detected, not blocked)
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, secret: false },
  { type: 'phone', re: /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g, secret: false },
];

export interface PiiHit {
  type: string;
  value: string;
  secret: boolean;
  index: number;
}

export function detectPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const value = m[0];
      if (p.validate && !p.validate(value)) continue;
      if (p.type === 'phone' && value.replace(/\D/g, '').length < 9) continue; // avoid years/salaries
      if (p.type === 'phone' && /^\d{4}\s*[-–]\s*\d{4}$/.test(value.trim())) continue; // "2020-2024"
      const idx = m.index ?? 0;
      // Skip overlaps with a stronger (earlier) match.
      if (hits.some((h) => idx < h.index + h.value.length && h.index < idx + value.length)) continue;
      hits.push({ type: p.type, value, secret: p.secret, index: idx });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function maskValue(type: string, value: string): string {
  if (type === 'email') {
    const [user, domain] = value.split('@');
    return `${user!.slice(0, 1)}***@${domain}`;
  }
  if (type === 'phone') return `${value.slice(0, 3)}***${value.slice(-2)}`;
  return `[REDACTED:${type}]`;
}

/** Redact secrets (always) and optionally mask working PII (emails/phones). */
export function redact(text: string, { maskWorkingPii = false } = {}): { text: string; hits: PiiHit[] } {
  const hits = detectPii(text);
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (!h.secret && !maskWorkingPii) continue;
    out += text.slice(cursor, h.index) + maskValue(h.type, h.value);
    cursor = h.index + h.value.length;
  }
  return { text: out + text.slice(cursor), hits };
}

export function piiFindings(text: string): { findings: Finding[]; redacted: string } {
  const { text: redacted, hits } = redact(text);
  const secrets = hits.filter((h) => h.secret);
  const findings: Finding[] = [];
  if (secrets.length) {
    findings.push({
      rail: 'secrets',
      verdict: 'block',
      reason: `Your message contains ${[...new Set(secrets.map((s) => s.type.replace(/_/g, ' ')))].join(', ')}. I removed it and did not store it or send it to the AI model.`,
      matches: secrets.map((s) => maskValue(s.type, s.value)),
    });
  }
  const working = hits.filter((h) => !h.secret);
  if (working.length) {
    findings.push({
      rail: 'pii',
      verdict: 'pass',
      reason: `Contains ${working.length} contact detail(s); treated as candidate data.`,
      matches: working.map((w) => maskValue(w.type, w.value)),
    });
  }
  return { findings, redacted };
}
