/**
 * Deterministic heuristics used when no LLM key is configured (mock mode) and in tests.
 * They are intentionally conservative: they only report what the text literally contains.
 */

export const KNOWN_SKILLS = [
  'React', 'React Native', 'Next.js', 'Vue', 'Angular', 'Svelte', 'TypeScript', 'JavaScript', 'Node.js', 'Express',
  'NestJS', 'GraphQL', 'REST', 'Redux', 'TanStack Query', 'Tailwind', 'CSS', 'HTML', 'Webpack', 'Vite', 'Jest',
  'Vitest', 'Cypress', 'Playwright', 'Testing Library', 'Python', 'Django', 'FastAPI', 'Flask', 'Go', 'Rust', 'Java',
  'Kotlin', 'Spring', 'C#', '.NET', 'Ruby', 'Rails', 'PHP', 'Laravel', 'MongoDB', 'PostgreSQL', 'MySQL', 'Redis',
  'BullMQ', 'Kafka', 'RabbitMQ', 'Elasticsearch', 'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform',
  'CI/CD', 'GitHub Actions', 'Linux', 'Microservices', 'System Design', 'LLM', 'OpenAI', 'LangChain', 'LangGraph',
  'RAG', 'Machine Learning', 'PyTorch', 'TensorFlow', 'NLP', 'Figma', 'Accessibility', 'Storybook', 'WebSockets',
  'SSE', 'Mongoose', 'Prisma', 'SQL', 'NoSQL', 'Swift', 'iOS', 'Android', 'Flutter', 'Agile', 'Scrum',
];

const SKILL_ALIASES: Record<string, string> = {
  'react.js': 'React', reactjs: 'React', 'node': 'Node.js', nodejs: 'Node.js', 'node.js': 'Node.js', ts: 'TypeScript',
  js: 'JavaScript', postgres: 'PostgreSQL', mongo: 'MongoDB', k8s: 'Kubernetes', 'next': 'Next.js', nextjs: 'Next.js',
  golang: 'Go', 'tailwindcss': 'Tailwind', 'react query': 'TanStack Query', 'ci-cd': 'CI/CD',
};

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skillRegex(skill: string): RegExp {
  // Word-ish boundaries that also work for "C#", ".NET", "Node.js".
  return new RegExp(`(^|[^a-z0-9+#.])${escapeRe(skill.toLowerCase())}(?![a-z0-9+#])`, 'i');
}

export function findSkills(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const s of KNOWN_SKILLS) {
    // "Go" is too common an English word; only count explicit Go-the-language mentions.
    if (s === 'Go' ? /\bgolang\b|\bgo\s*(developer|engineer|services|microservices)\b/i.test(text) : skillRegex(s).test(lower)) {
      found.add(s);
    }
  }
  for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
    if (skillRegex(alias).test(lower)) found.add(canonical);
  }
  // "React Native" also matches "React"; keep both only if React appears on its own.
  return [...found];
}

export function skillMatches(candidateText: string, skill: string): boolean {
  const lower = candidateText.toLowerCase();
  if (skillRegex(skill).test(lower)) return true;
  return Object.entries(SKILL_ALIASES).some(([alias, c]) => c === skill && skillRegex(alias).test(lower));
}

interface JdSections {
  must: string;
  nice: string;
  all: string;
}

function splitSections(jd: string): JdSections {
  const lines = jd.split(/\r?\n/);
  let mode: 'none' | 'must' | 'nice' = 'none';
  const must: string[] = [];
  const nice: string[] = [];
  for (const line of lines) {
    const l = line.toLowerCase();
    if (/nice[\s-]to[\s-]have|bonus|preferred|plus\b|good to have/.test(l) && line.length < 80) mode = 'nice';
    else if (/requirement|must[\s-]have|qualification|you have|what you.?ll need|skills|required/.test(l) && line.length < 80) mode = 'must';
    else if (/^(about|benefits|perks|what we offer|responsibilities|how to apply|compensation|salary)/.test(l.trim()) && line.length < 60) mode = 'none';
    if (mode === 'must') must.push(line);
    if (mode === 'nice') nice.push(line);
  }
  return { must: must.join('\n'), nice: nice.join('\n'), all: jd };
}

export interface HeuristicJob {
  title: string;
  company: string | null;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  seniority: string | null;
  location: string | null;
  salary: { raw: string | null; min: number | null; max: number | null; currency: string | null; period: string | null };
  remotePolicy: 'remote' | 'hybrid' | 'onsite' | 'unspecified';
  employmentType: string | null;
  summary: string;
}

function field(jd: string, names: string[]): string | null {
  for (const n of names) {
    const m = jd.match(new RegExp(`^\\s*${n}\\s*[:\\-–]\\s*(.+)$`, 'im'));
    if (m?.[1]) return m[1].trim().slice(0, 140);
  }
  return null;
}

function parseNumber(s: string): number {
  const n = parseFloat(s.replace(/,/g, ''));
  return /k$/i.test(s.trim()) ? n * 1000 : n;
}

export function heuristicExtractJob(jd: string): HeuristicJob {
  const firstLine = jd.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'Untitled role';
  const title =
    field(jd, ['job title', 'title', 'position', 'role']) ??
    firstLine.replace(/^(job description|jd)\s*[:\-–]\s*/i, '').replace(/[#*]/g, '').slice(0, 100);

  const sections = splitSections(jd);
  let must = findSkills(sections.must || jd);
  const nice = findSkills(sections.nice).filter((s) => !must.includes(s) || !sections.must);
  if (sections.nice) must = must.filter((s) => !nice.includes(s));

  const lower = jd.toLowerCase();
  const seniority =
    /\bprincipal\b/.test(lower) ? 'principal'
    : /\b(staff|lead)\b/.test(lower) ? 'lead'
    : /\b(senior|sr\.?)\b/.test(lower) ? 'senior'
    : /\b(mid[\s-]?level|intermediate)\b/.test(lower) ? 'mid'
    : /\b(junior|jr\.?|entry[\s-]level|graduate)\b/.test(lower) ? 'junior'
    : /\bintern(ship)?\b/.test(lower) ? 'intern'
    : null;

  const remotePolicy: HeuristicJob['remotePolicy'] = /\bhybrid\b/.test(lower)
    ? 'hybrid'
    : /\b(fully remote|remote[\s-]first|100% remote|remote)\b/.test(lower) && !/\bnot remote\b/.test(lower)
      ? 'remote'
      : /\b(on[\s-]?site|in[\s-]office|office[\s-]based)\b/.test(lower)
        ? 'onsite'
        : 'unspecified';

  const salaryLine = field(jd, ['salary', 'compensation', 'pay', 'salary range']);
  const salaryText = salaryLine ?? jd.match(/(?:[$€£৳]|USD|EUR|GBP|BDT)\s?[\d,.]+k?\s*(?:[-–to]+\s*(?:[$€£৳]|USD|EUR|GBP|BDT)?\s?[\d,.]+k?)?(?:\s*(?:\/|per)\s*(?:year|yr|month|mo|hour|hr|annum))?/i)?.[0] ?? null;
  let min: number | null = null;
  let max: number | null = null;
  let currency: string | null = null;
  let period: string | null = null;
  if (salaryText) {
    const nums = salaryText.match(/\d[\d,.]*k?/gi) ?? [];
    if (nums[0]) min = parseNumber(nums[0]);
    if (nums[1]) max = parseNumber(nums[1]);
    currency = /\$|usd/i.test(salaryText) ? 'USD' : /€|eur/i.test(salaryText) ? 'EUR' : /£|gbp/i.test(salaryText) ? 'GBP' : /৳|bdt/i.test(salaryText) ? 'BDT' : null;
    period = /month|\bmo\b/i.test(salaryText) ? 'month' : /hour|\bhr\b/i.test(salaryText) ? 'hour' : /year|annum|\byr\b/i.test(salaryText) ? 'year' : null;
  }

  const employmentType = /\bcontract\b/.test(lower) ? 'contract' : /\bpart[\s-]time\b/.test(lower) ? 'part-time' : /\bfull[\s-]time\b/.test(lower) ? 'full-time' : null;

  return {
    title,
    company: field(jd, ['company', 'employer', 'organization']),
    mustHaveSkills: must.slice(0, 15),
    niceToHaveSkills: nice.slice(0, 15),
    seniority,
    location: field(jd, ['location', 'based in', 'office']),
    salary: { raw: salaryText, min, max, currency, period },
    remotePolicy,
    employmentType,
    summary: `${title}${seniority ? ` (${seniority})` : ''} role${must.length ? ` requiring ${must.slice(0, 4).join(', ')}` : ''}.`,
  };
}

export interface ScoreInput {
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  seniority?: string | null;
  location?: string | null;
  remotePolicy: string;
}

export interface CandidateFacts {
  name: string;
  headline?: string | null;
  skills: string[];
  location?: string | null;
  yearsExperience?: number | null;
  snippet?: string | null;
  email?: string | null;
}

/** Transparent keyword rubric: 60 must-have, 20 seniority, 20 nice-to-have/location. */
export function heuristicScore(job: ScoreInput, c: CandidateFacts) {
  const text = [c.headline, c.skills.join(', '), c.snippet].filter(Boolean).join(' \n ');
  const matchedMust = job.mustHaveSkills.filter((s) => skillMatches(text, s));
  const matchedNice = job.niceToHaveSkills.filter((s) => skillMatches(text, s));
  const mustPts = job.mustHaveSkills.length ? (matchedMust.length / job.mustHaveSkills.length) * 60 : 30;
  const nicePts = job.niceToHaveSkills.length ? (matchedNice.length / job.niceToHaveSkills.length) * 12 : 6;

  let seniorityPts = 8;
  const t = text.toLowerCase();
  const years = c.yearsExperience ?? null;
  const want = job.seniority ?? null;
  if (want) {
    const isSenior = /\b(senior|sr\.?|lead|staff|principal)\b/.test(t) || (years !== null && years >= 5);
    const isJunior = /\b(junior|jr\.?|intern|graduate)\b/.test(t) || (years !== null && years < 2);
    if (['senior', 'lead', 'principal'].includes(want)) seniorityPts = isSenior ? 20 : isJunior ? 2 : years === null ? 8 : 12;
    else if (want === 'junior' || want === 'intern') seniorityPts = isJunior ? 20 : 12;
    else seniorityPts = isJunior ? 10 : 18;
  }

  let locPts = 4;
  if (job.remotePolicy === 'remote') locPts = 8;
  else if (job.location && c.location) {
    const jl = job.location.toLowerCase().split(/[,\s]+/).filter((w) => w.length > 2);
    locPts = jl.some((w) => c.location!.toLowerCase().includes(w)) ? 8 : 2;
  }

  const missingData: string[] = [];
  if (!c.email) missingData.push('email');
  if (years === null) missingData.push('years of experience');
  if (!c.skills.length) missingData.push('skills list');
  if (!c.location) missingData.push('location');

  const thin = !c.skills.length && (c.snippet?.length ?? 0) < 120;
  const score = Math.max(0, Math.min(100, Math.round(mustPts + nicePts + seniorityPts + locPts)));
  const missingMust = job.mustHaveSkills.filter((s) => !matchedMust.includes(s));
  const reason =
    `Matches ${matchedMust.length}/${job.mustHaveSkills.length} must-haves` +
    (matchedMust.length ? ` (${matchedMust.slice(0, 4).join(', ')})` : '') +
    (missingMust.length ? `; no evidence of ${missingMust.slice(0, 3).join(', ')}` : '') +
    (years !== null ? `; ${years} yrs experience` : '') +
    '.';
  return {
    score,
    reason: reason.slice(0, 240),
    confidence: (thin ? 'low' : missingData.length > 2 ? 'medium' : 'high') as 'low' | 'medium' | 'high',
    matchedSkills: [...matchedMust, ...matchedNice],
    missingData,
  };
}

export type HeuristicReplyClass = 'interested' | 'not_interested' | 'question' | 'wants_meeting' | 'unsubscribe';

/** Keyword classifier with the same precedence as the LLM prompt. */
export function heuristicClassifyReply(body: string): { classification: HeuristicReplyClass; confidence: number; summary: string; questions: string[] } {
  const t = body.toLowerCase();
  const questions = body
    .split(/(?<=[?])\s+/)
    .filter((s) => s.trim().endsWith('?'))
    .map((s) => s.trim())
    .slice(0, 5);
  if (/\b(unsubscribe|remove me|stop (emailing|contacting|messaging)|do not (contact|email)|don'?t (contact|email)|take me off|opt[\s-]?out|spam)\b/.test(t))
    return { classification: 'unsubscribe', confidence: 0.95, summary: 'Candidate asked to stop receiving emails.', questions: [] };
  if (/\b(not interested|no longer interested|not looking|happy (where|in my)|pass on this|not a (good )?fit|decline|no thanks|not open to)\b/.test(t))
    return { classification: 'not_interested', confidence: 0.85, summary: 'Candidate declined the opportunity.', questions };
  if (/\b(call|chat|meet|meeting|schedule|calendar|calendly|available (on|at|this|next)|free (on|at)|time slot|book|zoom|google meet|teams)\b/.test(t))
    return { classification: 'wants_meeting', confidence: 0.8, summary: 'Candidate wants to schedule a conversation.', questions };
  // Clear interest wins over a trailing logistics question ("I'm interested, what are next steps?").
  if (/\b(definitely interested|very interested|i'?m interested|sounds (great|good|interesting)|tell me more|keen|excited|love to|open to it|send (over )?(more )?details|next steps)\b/.test(t))
    return { classification: 'interested', confidence: questions.length ? 0.7 : 0.8, summary: 'Candidate is interested in the role.', questions };
  if (questions.length)
    return { classification: 'question', confidence: 0.75, summary: 'Candidate asked questions before deciding.', questions };
  if (/\b(interested|happy to|would like to)\b/.test(t))
    return { classification: 'interested', confidence: 0.65, summary: 'Candidate is interested in the role.', questions };
  return { classification: 'question', confidence: 0.4, summary: 'Reply is ambiguous; recruiter review needed.', questions };
}
