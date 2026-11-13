/**
 * Urgency rail (port of the notebook's `classify_urgency` action) applied to inbound candidate replies.
 * In recruiting, "urgent" means you are about to lose the candidate: competing offers and deadlines.
 * High-urgency replies are flagged on the card and sorted first; they never trigger an automatic send.
 */
export interface Urgency {
  level: 'high' | 'normal';
  signals: string[];
}

const SIGNALS: [string, RegExp][] = [
  ['competing offer', /\b(?:another|other|competing|counter)[ -]?offers?\b|\boffer from\b|\breceived an offer\b|\bhave an offer\b/i],
  ['deadline', /\b(?:deadline|expires?|expiring|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|end of (?:day|week))|within (?:\d+|a|two|three) (?:days?|hours?)|asap|as soon as possible)\b/i],
  ['time-sensitive', /\b(?:urgent(?:ly)?|today|tonight|right away|immediately|this week only)\b/i],
  ['notice period ending', /\b(?:last day|leaving (?:my|the) (?:job|company)|notice period (?:ends|is over))\b/i],
];

export function detectUrgency(text: string): Urgency {
  const signals = SIGNALS.filter(([, re]) => re.test(text)).map(([s]) => s);
  const high = signals.includes('competing offer') || signals.includes('deadline') || signals.length >= 2;
  return { level: high ? 'high' : 'normal', signals };
}
