import crypto from 'node:crypto';
import type { ChatParams, ChatResult, ToolCall } from '../llm/types';

/**
 * Deterministic rule-based "LLM" used when no API key is configured (LLM_PROVIDER=mock).
 * It speaks the same tool-calling protocol as the real providers, so the whole agent loop,
 * proposal cards, workers and guardrails can be demoed and tested offline.
 * It is intentionally simple: anything it doesn't recognise gets a help message.
 */

const id = () => `mock_${crypto.randomBytes(6).toString('hex')}`;

function call(name: string, input: Record<string, unknown>): ChatResult {
  const toolCalls: ToolCall[] = [{ id: id(), name, input }];
  return { text: '', toolCalls, usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock-agent', stopReason: 'tool_use' };
}

function say(text: string): ChatResult {
  return { text, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock-agent', stopReason: 'end' };
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s: string | undefined) => (s ? (NUM_WORDS[s.toLowerCase()] ?? parseInt(s, 10)) : NaN);

function splitNames(s: string): string[] {
  return s
    .replace(/\b(candidates?|please|for me|now|the)\b/gi, ' ')
    .split(/,|\band\b|&/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

function selectorFrom(phrase: string): Record<string, unknown> | null {
  const p = phrase.trim();
  const top = p.match(/top\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)/i);
  if (top) return { top: num(top[1]) };
  const above = p.match(/(?:above|over|>=?|at least)\s*(\d{1,3})/i);
  if (above) return { minScore: Number(above[1]) };
  const below = p.match(/(?:below|under|<)\s*(\d{1,3})/i);
  if (below) return { maxScore: Number(below[1]) };
  if (/\b(all|everyone|everybody)\b/i.test(p)) return { all: true };
  const names = splitNames(p);
  return names.length ? { names } : null;
}

function lastToolResults(p: ChatParams) {
  const out: { name: string; content: string }[] = [];
  for (let i = p.messages.length - 1; i >= 0; i--) {
    const m = p.messages[i]!;
    if (m.role !== 'tool') break;
    out.unshift({ name: m.name, content: m.content });
  }
  return out;
}

function afterTools(results: { name: string; content: string }[]): ChatResult {
  const r = results[results.length - 1]!;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.content);
  } catch {
    /* ignore */
  }
  if (data.error) return say(String(data.error));
  if (r.name === 'propose_create_job') return say('I extracted the job details below. Edit anything that is off, then confirm to create the job.');
  if (r.name === 'propose_start_sourcing')
    return say(data.webSearchAvailable ? 'Ready to source. Adjust the query or attach a CSV on the card, then confirm.' : 'Web search is not configured, so upload a CSV of candidates on the card, then confirm.');
  if (r.name === 'propose_review_decisions') return say(`Here's exactly who will change. Confirm to apply.`);
  if (r.name === 'propose_campaign') {
    const excluded = (data.excluded as { name: string; reason: string }[] | undefined) ?? [];
    return say(`I drafted personalised emails for ${(data.recipients as string[]).length} candidate(s). Review and edit them, then approve to start sending.${excluded.length ? ` Excluded: ${excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}.` : ''}`);
  }
  if (r.name === 'propose_status_change') return say('Please confirm the status change on the card.');
  if (r.name === 'propose_campaign_control') return say(`Confirm to ${data.action} "${data.campaign}".`);
  if (r.name === 'propose_job_settings') return say('Confirm to update the auto-reply setting.');
  if (r.name === 'search_talent_pool') {
    const m = (data.matches as { name: string; fromJob: string; similarity: number }[]) ?? [];
    return say(m.length ? `Found ${m.length} match(es) from earlier jobs: ${m.slice(0, 5).map((x) => `${x.name} (${x.fromJob}, ${Math.round(x.similarity * 100)}%)`).join(', ')}. Say "start sourcing" to bring them into this job.` : String(data.note));
  }
  if (r.name === 'propose_update_email') return say(`Confirm to save this email for ${data.candidate}.`);
  if (r.name === 'get_stats') return say(String(data.summary ?? 'Here are the latest numbers.'));
  if (r.name === 'get_candidates') return say(`Showing ${data.shown} of ${data.total} candidates.`);
  if (r.name === 'list_jobs') {
    const jobs = (data.jobs as { title: string }[]) ?? [];
    return say(jobs.length ? `Jobs: ${jobs.map((j) => j.title).join(', ')}.` : 'No jobs yet. Paste a job description to create one.');
  }
  if (r.name === 'get_candidate') {
    const c = data.candidate as Record<string, unknown> | undefined;
    return say(c ? `${c.name}: ${c.status}, score ${c.score ?? 'n/a'}. Email: ${c.email}.` : 'Here is what I found.');
  }
  return say('Done.');
}

export function mockChat(p: ChatParams): ChatResult {
  const results = lastToolResults(p);
  if (results.length) return afterTools(results);

  const lastUser = [...p.messages].reverse().find((m) => m.role === 'user');
  const text = lastUser && lastUser.role === 'user' ? lastUser.content.trim() : '';
  const t = text.toLowerCase();

  // Job creation: a long paste, or a short message with a link.
  if (text.length > 250 && !/^(accept|reject|mark|move)\b/i.test(text)) return call('propose_create_job', { source: 'message' });
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url) return call('propose_create_job', { source: 'url', url });

  const similar = text.match(/\b(?:similar to|like)\s+([A-Z][A-Za-z .'-]+?)\??$/);
  if (/\btalent pool\b|\bprevious (?:jobs|searches)\b|\bearlier jobs\b|\brediscover/i.test(t) || (similar && /\b(?:find|anyone|people|candidates)\b/i.test(t)))
    return call('search_talent_pool', similar ? { similarTo: similar[1]!.trim() } : {});

  const emailSet = text.match(/^(?:set\s+)?([A-Za-z][A-Za-z .'-]+?)(?:'s|’s)?\s+(?:e-?mail(?:\s+address)?\s+(?:is|to|=)|e-?mail:)\s*([^\s,;]+@[^\s,;]+)/i);
  if (emailSet) return call('propose_update_email', { candidate: emailSet[1]!.trim(), email: emailSet[2]!.replace(/[.)]+$/, '') });

  const acc = t.match(/\baccept\s+(.+?)(?:\s+and\s+reject\s+(.+))?$/i);
  if (acc) {
    const accept = selectorFrom(acc[1]!);
    const reject = acc[2] ? selectorFrom(acc[2]) : null;
    return call('propose_review_decisions', { ...(accept ? { accept } : {}), ...(reject ? { reject } : {}) });
  }
  const rej = t.match(/\breject\s+(.+)$/i);
  if (rej && !/\bmark|move\b/.test(t)) {
    const reject = selectorFrom(rej[1]!);
    if (reject) return call('propose_review_decisions', { reject });
  }
  const mark = text.match(/\b(?:mark|move|set|update)\s+(.+?)\s+(?:as|to)\s+([a-z ]+?)\.?$/i);
  if (mark) {
    const sel = selectorFrom(mark[1]!);
    if (sel) return call('propose_status_change', { candidates: sel, to: mark[2]!.trim() });
  }
  if (/\b(pause)\b.*\b(campaign|outreach|sending)\b|\bpause\b/.test(t)) return call('propose_campaign_control', { action: 'pause' });
  if (/\b(resume|unpause|restart)\b/.test(t)) return call('propose_campaign_control', { action: 'resume' });
  if (/\bauto[- ]?(reply|send)\b/.test(t)) return call('propose_job_settings', { autoReply: /\b(off|disable|stop|turn off)\b/.test(t) ? 'off' : 'meetings_only' });
  if (/\b(campaign|outreach|sequence|email (them|the)|reach out|draft emails?)\b/.test(t)) {
    const days = [...t.matchAll(/day\s*(\d+)/g)].map((m) => Number(m[1]));
    const single = /\bsingle|one email|just one\b/.test(t);
    return call('propose_campaign', { ...(days.length ? { stepDays: days } : single ? { stepDays: [0] } : {}) });
  }
  if (/\b(source|sourcing|find candidates|search (for )?candidates|start searching)\b/.test(t)) return call('propose_start_sourcing', {});
  if (/\b(how is|how's|how are|going|progress|stats|status of|summary|funnel|report)\b/.test(t)) {
    const job = t.match(/how(?:'s| is)\s+the\s+(.+?)\s+(?:job|role|position)/)?.[1];
    return call('get_stats', job ? { job } : {});
  }
  if (/\b(list|show|which)\b.*\bjobs?\b/.test(t)) return call('list_jobs', {});
  const who = text.match(/\b(?:who is|tell me about|details (?:on|for)|info on)\s+([A-Za-z][A-Za-z .'-]+)\??$/i);
  if (who) return call('get_candidate', { name: who[1]!.trim() });
  if (/\b(candidates|pipeline|table|shortlist|show)\b/.test(t)) {
    const st = t.match(/\b(sourced|accepted|rejected|contacted|replied|interested|interviewed|shortlisted|hired)\b/)?.[1];
    return call('get_candidates', st ? { status: st } : {});
  }
  if (/\b(activity|history|log)\b/.test(t)) return call('get_activity', {});
  if (/\b(replies|inbox)\b/.test(t)) return call('list_replies', {});

  return say(
    'I\'m running in offline demo mode (no LLM key), so I understand a fixed set of commands: paste a job description or link, "start sourcing", "accept the top 5", "reject Jane", "create a campaign day 0, 3, 7", "mark Rahim as hired", "how is the job going?", "pause campaign", "turn on auto-reply".',
  );
}
