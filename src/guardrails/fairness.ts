import type { Finding, Verdict } from './types';

/**
 * Fair-hiring rail: the recruiting equivalent of the notebook's "sensitive topic" rail.
 *
 * Hiring is classified as high-risk AI (EU AI Act, Annex III) and protected characteristics are
 * covered by equal-employment law in most jurisdictions. This rail detects selection decisions or
 * content based on protected characteristics:
 *   age, gender/sex, pregnancy/family status, marital status, religion, race/ethnicity/caste,
 *   national origin, disability/health, sexual orientation, appearance.
 *
 * It is applied to: recruiter chat commands (block), job descriptions (warn on the job card),
 * LLM score reasons (flag for review) and outbound emails (block at commit).
 *
 * Precision matters: "reject everyone below 40" is about SCORES, "reject everyone over 40 years old"
 * is about AGE. Age needs an explicit age cue; other attributes need a selection/inference verb nearby
 * to block, and only warn otherwise (e.g. a JD's "young and dynamic team").
 */

interface AttributeRule {
  attribute: string;
  /** Mentions of the attribute itself. */
  re: RegExp;
}

const ATTRIBUTES: AttributeRule[] = [
  {
    attribute: 'age',
    re: /\b(?:(?:under|over|below|above|older than|younger than|at most|at least|max(?:imum)?|min(?:imum)?)\s+(?:the\s+age\s+of\s+)?\d{2}\s*(?:years?\s*old|yrs?\s*old|y\/?o)\b|\d{2}\s*(?:years?\s*old|yrs?\s*old|y\/?o)\b|\bage[ds]?\s*(?:limit|cap|range|requirement|between|under|over|below|above|of)?\s*\d{2}\b|\b(?:too|very)\s+old\b|\boldies?\b|\bboomers?\b|\bgen\s*z\b|\bmillennials?\b|\byoung(?:er)?\b[\s,]+(?:\w+[\s,]+){0,2}(?:people|candidates|guys|girls|talent|blood|team|professionals?|engineers?|developers?|graduates)\b|\bdigital natives?\b|\bborn\s+(?:after|before|in)\s+(?:19|20)\d{2}\b|\b(?:recent\s+grad(?:uate)?s?\s+only)\b|\b(?:people|folks|guys|girls|anyone|someone|nobody|no one)\s+(?:under|over|older than|younger than|above|below)\s+\d{2}\b|\bage\b)/i,
  },
  {
    attribute: 'gender',
    re: /\b(?:men|women|males?|females?|guys|girls|ladies|gentlemen|man|woman|gender|sex|he\/him|she\/her|non-?binary|transgender)\b/i,
  },
  { attribute: 'pregnancy or family status', re: /\b(?:pregnan\w*|maternity|paternity|has kids|have kids|having kids|children|plans? to (?:have|start) (?:a )?(?:family|kids)|mothers?|fathers?|single parents?)\b/i },
  { attribute: 'marital status', re: /\b(?:married|unmarried|divorced|marital status|spouse|wife|husband|single (?:people|candidates|women|men|guys|girls|ladies))\b/i },
  { attribute: 'religion', re: /\b(?:religio\w*|muslims?|islamic|hindus?|christians?|jew(?:s|ish)?|buddhists?|sikhs?|atheists?|hijab|church|mosque|pray(?:s|ing)?)\b/i },
  {
    attribute: 'race or ethnicity',
    re: /\b(?:race|racial|ethnicit\w*|ethnic|skin (?:colou?r|tone)|caste|white (?:people|candidates|guys)|black (?:people|candidates|guys)|asians?|africans?|hispanics?|latin[oax]s?|arabs?|indians? only|bengalis? only)\b/i,
  },
  { attribute: 'national origin', re: /\b(?:nationality|national origin|foreigners?|immigrants?|(?:only|no)\s+(?:locals?|natives?|expats?)|native[- ]born|citizens? only)\b/i },
  { attribute: 'disability or health', re: /\b(?:disab\w*|handicap\w*|wheelchair|blind|deaf|autis\w*|adhd|mental (?:health|illness)|chronic(?:ally)? ill|illness|medical condition|health (?:issues|problems|condition))\b/i },
  { attribute: 'sexual orientation', re: /\b(?:gay|lesbian|lgbtq?\+?|homosexual|heterosexual|straight (?:people|candidates|guys)|sexual orientation|queer)\b/i },
  { attribute: 'appearance', re: /\b(?:attractive(?!\s+(?:salary|package|compensation|benefits|offer|pay|role|opportunity))|good[- ]looking|pretty|handsome|beautiful|ugly|overweight|fat|slim|photo(?:graph)? (?:required|attached))\b/i },
];

/** Verbs that turn a mention into a selection decision or an inference about a person. */
const SELECTION =
  /\b(?:only|just|prefer(?:ably|red|ence)?|exclud\w*|reject\w*|filter(?:\s+out)?|remove|drop|skip|ignore|don'?t|do not|never|no|avoid|rank|score|downgrade|deprioriti[sz]e|prioriti[sz]e|favou?r|must be|should be|has to be|needs? to be|hire|shortlist|accept|pick|choose|select|target|look(?:ing)? for|want|bar|ban)\b/i;
const INFERENCE = /\b(?:guess|infer|determine|predict|figure out|work out|find out|detect|estimate|tell me|identify|check)\b[^.?!]{0,60}\b(?:age|gender|sex|religion|ethnicity|race|nationality|orientation|married|pregnan\w*|disab\w*|caste)\b/i;

/** Phrases that look like an attribute but are standard, lawful job-ad language. */
const SAFE = [
  /\bequal opportunity\b/i,
  /\bregardless of (?:age|gender|race|religion|sex|disability|nationality)/i,
  /\bdiversity\b/i,
  /\bwithout regard to\b/i,
  /\bwomen in tech\b/i,
  /\bparental leave\b/i,
  /\b(?:right|authori[sz]ation|permit|eligib\w*) to work\b/i,
  /\bvisa sponsorship\b/i,
];

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
}

export interface FairnessScan {
  verdict: Verdict;
  findings: Finding[];
}

/**
 * @param mode 'command'   recruiter instruction: selection + attribute → block
 *             'document'  JD / email: selection + attribute → block for emails, warn for JDs
 */
export function scanFairness(text: string, mode: 'command' | 'jd' | 'email' | 'reason'): FairnessScan {
  const findings: Finding[] = [];
  for (const s of sentences(text)) {
    if (SAFE.some((re) => re.test(s))) continue;
    if (INFERENCE.test(s)) {
      findings.push({
        rail: 'fairness',
        verdict: 'block',
        reason: 'Inferring protected characteristics (age, gender, religion, ethnicity, …) about candidates is not allowed.',
        matches: [s.slice(0, 160)],
      });
      continue;
    }
    for (const a of ATTRIBUTES) {
      const m = s.match(a.re);
      if (!m) continue;
      // Gender words like "man" are too common in non-hiring contexts; require a selection verb for them.
      const selected = SELECTION.test(s);
      if (!selected && (mode === 'command' || mode === 'reason') && a.attribute !== 'age') continue;
      if (a.attribute === 'age' && /\bage\b/i.test(m[0]) && m[0].trim().toLowerCase() === 'age' && !selected) continue;
      const verdict: Verdict = mode === 'jd' ? 'warn' : selected || mode === 'reason' ? 'block' : 'warn';
      findings.push({
        rail: 'fairness',
        verdict,
        reason:
          mode === 'jd'
            ? `The job description may reference ${a.attribute} ("${m[0].trim()}"). Consider rewording to job-related criteria.`
            : mode === 'reason'
              ? `The score reason references ${a.attribute}; scores must be based on job-related evidence only.`
              : `Selecting or treating candidates differently based on ${a.attribute} is not allowed. Use job-related criteria (skills, experience, location/remote fit).`,
        matches: [m[0].trim()],
      });
      break;
    }
  }
  const verdict: Verdict = findings.some((f) => f.verdict === 'block') ? 'block' : findings.length ? 'warn' : 'pass';
  return { verdict, findings: dedupe(findings) };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.verdict}:${f.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
