/**
 * Deterministic chat confirmation matcher.
 *
 * The LLM never decides whether a message counts as "confirm". A message only
 * confirms a pending proposal if, after normalisation, it is *purely* an
 * affirmation ("yes", "confirm", "go ahead", "looks good, send it"). Anything with
 * extra content ("yes but change the subject") is routed to the agent instead.
 */

const AFFIRM = new Set([
  'y',
  'yes',
  'yep',
  'yeah',
  'yup',
  'sure',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'go ahead',
  'go for it',
  'do it',
  'proceed',
  'ship it',
  'send it',
  'send',
  'looks good',
  'lgtm',
  'sounds good',
  'start',
  'start it',
  'yes please',
  'yes confirm',
  'yes go ahead',
  'yes do it',
  'yes send it',
  'yes proceed',
  'confirm it',
  'please confirm',
  'please proceed',
  'looks good send it',
  'looks good go ahead',
  'looks good confirm',
  'approve and send',
  'confirm and send',
  'yes start',
  'yes start sourcing',
  'start sourcing',
  'create it',
  'create the job',
  'yes create it',
  'launch it',
  'launch',
]);

const CANCEL = new Set([
  'no',
  'nope',
  'cancel',
  'cancel it',
  'stop',
  'abort',
  'never mind',
  'nevermind',
  'dont',
  'do not',
  'discard',
  'discard it',
  'no thanks',
  'no cancel',
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ConfirmIntent = 'confirm' | 'cancel' | null;

export function matchConfirmIntent(text: string): ConfirmIntent {
  if (text.length > 60) return null;
  const n = normalize(text);
  if (!n) return null;
  if (AFFIRM.has(n)) return 'confirm';
  if (CANCEL.has(n)) return 'cancel';
  return null;
}
