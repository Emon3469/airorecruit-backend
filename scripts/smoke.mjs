// Live smoke test against a running API (npm run dev:all). Usage: node scripts/smoke.mjs [baseUrl]
// Drives JD -> hire over HTTP, using real BullMQ workers, and listens to SSE.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function until(label, fn, timeoutMs = 90_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// SSE listener
const events = [];
const ctrl = new AbortController();
async function listen(convId) {
  const res = await fetch(`${BASE}/api/events?conversationId=${convId}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.+)$/m)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(chunk.match(/^data: (.+)$/m)[1]) });
      }
    }
  } catch {}
}
const pendingOf = async (convId, type) => (await api('GET', `/api/conversations/${convId}`)).pendingActions.find((a) => a.type === type);

const { conversation } = await api('POST', '/api/conversations');
const convId = conversation._id;
listen(convId);
log('conversation', convId);

// 1. JD -> job
await api('POST', `/api/conversations/${convId}/messages`, { content: fs.readFileSync(path.join(root, 'seed/sample-jd.txt'), 'utf8') });
const jobProp = await pendingOf(convId, 'CREATE_JOB');
log('JOB_CONFIRM card:', jobProp.payload.draft.title, '| must:', jobProp.payload.draft.mustHaveSkills.join(', '));
await api('POST', `/api/actions/${jobProp._id}/confirm`);
const jobId = (await api('GET', '/api/jobs')).jobs.find((j) => j.conversationId === convId)._id;
log('job created', jobId);

// 2. CSV upload attaches to the pending sourcing card, confirm
const form = new FormData();
form.append('file', new Blob([fs.readFileSync(path.join(root, 'seed/candidates.csv'))], { type: 'text/csv' }), 'candidates.csv');
form.append('conversationId', convId);
const up = await (await fetch(`${BASE}/api/jobs/${jobId}/candidates/upload`, { method: 'POST', body: form })).json();
log('csv upload:', up.validRows, 'valid,', up.invalidRows.length, 'invalid; attached to', up.pendingActionId);
await api('PATCH', `/api/actions/${up.pendingActionId}`, { payload: { useWebSearch: false } });
await api('POST', `/api/conversations/${convId}/messages`, { content: 'yes' });
const run = await until('sourcing done', async () => {
  const r = (await api('GET', `/api/jobs/${jobId}/sourcing-runs`)).runs[0];
  return r?.status === 'completed' || r?.status === 'failed' ? r : null;
});
log(`sourcing ${run.status}: found ${run.found}, created ${run.created}, duplicates ${run.duplicates}, invalid ${run.invalid}, scored ${run.scored}/${run.total}`);
const progress = events.filter((e) => e.ev === 'sourcing.progress');
log('SSE sourcing.progress events:', progress.length, '| last:', JSON.stringify(progress.at(-1)?.data.data));

// 3. review via chat
await api('POST', `/api/conversations/${convId}/messages`, { content: 'accept the top 5' });
await api('POST', `/api/conversations/${convId}/messages`, { content: 'confirm' });
const accepted = (await api('GET', `/api/jobs/${jobId}/candidates?status=Accepted`)).candidates;
log('accepted:', accepted.map((c) => `${c.name}(${c.score})`).join(', '));

// 4. campaign
await api('POST', `/api/conversations/${convId}/messages`, { content: 'create a campaign day 0, day 1, day 2' });
const campProp = await pendingOf(convId, 'CREATE_CAMPAIGN');
log('campaign card: recipients', campProp.payload.recipients.length, '| excluded:', campProp.payload.excluded.map((e) => `${e.name}: ${e.reason}`).join('; '));
await api('POST', `/api/actions/${campProp._id}/confirm`, { payload: { dailyLimit: 3 } });
const campId = (await api('GET', `/api/jobs/${jobId}/campaigns`)).campaigns[0].id;
const c1 = await until('3 sent', async () => {
  const c = (await api('GET', `/api/campaigns/${campId}`)).campaign;
  return c.totals.sent >= 3 ? c : null;
});
await sleep(3000);
const c1b = (await api('GET', `/api/campaigns/${campId}`)).campaign;
log(`campaign: sent ${c1b.totals.sent} (daily limit 3, sentToday=${c1b.sentToday}); preview: ${c1b.recipients.flatMap((r) => r.steps).find((s) => s.previewUrl)?.previewUrl ?? 'n/a'}`);

// 5. reply from a contacted candidate -> follow-ups stop
const contacted = (await api('GET', `/api/jobs/${jobId}/candidates?status=Contacted`)).candidates;
const target = contacted[0];
const rep = await api('POST', '/simulate-reply', { candidateId: target._id, body: 'Thanks! Happy to jump on a call. Are you free Thursday afternoon?' });
log(`simulate-reply for ${target.name}: stoppedFollowUps=${rep.stoppedFollowUps}`);
const reply = await until('reply processed', async () => {
  const r = (await api('GET', `/api/replies/${rep.replyId}`)).reply;
  return r.status !== 'received' ? r : null;
});
log(`classified ${reply.classification} (${reply.confidence}); draft status ${reply.draftStatus}`);
const sendProp = await until('reply draft card', () => pendingOf(convId, 'SEND_REPLY'));
await api('POST', `/api/actions/${sendProp._id}/confirm`);
const sentReply = await until('reply sent', async () => {
  const r = (await api('GET', `/api/replies/${rep.replyId}`)).reply;
  return r.draftStatus === 'sent' ? r : null;
});
log('reply sent; preview:', sentReply.sentPreviewUrl ?? 'n/a');

// 6. booking -> meeting booked, then chat status changes to hired
const token = reply.bookingToken;
const booking = await api('GET', `/api/booking/${token}`);
await api('POST', `/api/booking/${token}`, { slot: booking.slots[0] });
const first = target.name.split(' ')[0];
for (const s of ['interviewed', 'shortlisted', 'hired']) {
  await api('POST', `/api/conversations/${convId}/messages`, { content: `mark ${first} as ${s}` });
  await api('POST', `/api/conversations/${convId}/messages`, { content: 'yes' });
}
const hired = (await api('GET', `/api/candidates/${target._id}`)).candidate;
log(`${hired.name} status: ${hired.status}`);

// 7. let follow-up day pass; replied candidate must not get step 2
log('waiting ~25s for day-1 follow-ups (OUTREACH_DAY_MS=20000)...');
await sleep(25_000);
const camp = (await api('GET', `/api/campaigns/${campId}`)).campaign;
const tRec = camp.recipients.find((r) => r.candidateId === target._id);
log(`${target.name} steps: ${tRec.steps.map((s) => `${s.stepNumber}:${s.status}`).join(' ')} (state ${tRec.state})`);
for (const r of camp.recipients) if (r.candidateId !== target._id) log(`  ${r.name}: ${r.steps.map((s) => `${s.stepNumber}:${s.status}`).join(' ')}`);

// 8. stats
const stats = await api('GET', `/api/jobs/${jobId}/stats`);
log('funnel:', stats.funnel.map((f) => `${f.label}=${f.count}`).join(' '), '| replyRate', stats.rates.replyRate, '| emailsSent', stats.outreach.emailsSent);
const summary = await api('GET', `/api/jobs/${jobId}/summary`);
log('summary:', summary.summary);
const evCounts = events.reduce((m, e) => ((m[e.ev] = (m[e.ev] ?? 0) + 1), m), {});
log('SSE events received:', JSON.stringify(evCounts));
ctrl.abort();
process.exit(0);
