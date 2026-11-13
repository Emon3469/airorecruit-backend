/**
 * Normalization used for deduplication. Dedupe is enforced by unique partial
 * indexes on (jobId, emailLower) and (jobId, profileUrlCanonical), so these
 * functions define what "the same person" means.
 */

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase().replace(/^mailto:/, '');
  return EMAIL_RE.test(e) ? e : null;
}

/**
 * Canonical profile URL: https, no www/locale subdomain, no query/hash, no trailing slash, lowercase.
 * linkedin.com/in/jane-doe-123/?trk=x and https://bd.linkedin.com/in/Jane-Doe-123 are the same profile.
 */
export function canonicalizeProfileUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  // LinkedIn serves the same profile on country subdomains (bd., uk., www.)
  if (host.endsWith('linkedin.com')) host = 'linkedin.com';
  else host = host.replace(/^www\./, '');
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase();
  if (!path || path === '/') return null;
  return `https://${host}${path}`;
}

export function isLinkedInProfileUrl(url: string | null): boolean {
  return !!url && /^https:\/\/linkedin\.com\/in\/[^/]+$/.test(url);
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** "Jane Doe - Senior React Engineer - Acme | LinkedIn" → { name, headline } */
export function parseSerperTitle(title: string): { name: string; headline: string | null } {
  const cleaned = title.replace(/\s*[|·]\s*LinkedIn.*$/i, '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  const name = cleanName(parts[0] ?? '');
  const headline = parts.length > 1 ? parts.slice(1).join(' - ').replace(/^[\s|·•-]+|[\s|·•.-]+$/g, '').trim() : null;
  return { name, headline: headline || null };
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function splitList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[;,|/]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}
