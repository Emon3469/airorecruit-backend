import { runInputRails } from '../src/guardrails/engine';
import { llmIntentClassifier } from '../src/guardrails/llmClassifier';
import { checkOutboundEmail } from '../src/guardrails/outbound';
import { scanFairness } from '../src/guardrails/fairness';
import { classifyReplyText } from '../src/services/reply.service';
import { handleUserMessage } from '../src/agent/agent';
import { applyDecisions } from '../src/services/pipeline.service';
import { Candidate, ChatMessage, LlmUsage, PendingAction } from '../src/models';
import { readJson, seedJob, stateFingerprint } from './lib/stack';

export interface CaseResult {
  id: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  detail?: string;
}
export interface SuiteResult {
  suite: string;
  metrics: Record<string, number | null>;
  cases: CaseResult[];
  ms: number;
}

const ratio = (n: number, d: number) => (d ? Number((n / d).toFixed(4)) : null);

/* ===================================================================== guardrails: input rails */
interface InputCase {
  text: string;
  expect: 'block' | 'respond' | 'warn' | 'allow';
  rail?: string;
}
export async function guardrailInputSuite(file = 'evals/datasets/guardrails.input.json', suiteName = 'guardrails.input'): Promise<SuiteResult> {
  const t0 = Date.now();
  const { cases } = readJson<{ cases: InputCase[] }>(file);
  const out: CaseResult[] = [];
  for (const c of cases) {
    // Full rail stack: deterministic layer + LLM recall layer (active only when a real model is configured).
    const d = await runInputRails(c.text, { llmClassify: llmIntentClassifier });
    const actual = d.action === 'allow' ? (d.rail === 'hitl_bypass' ? 'warn' : 'allow') : d.action;
    const railOk = !c.rail || c.expect === 'allow' || d.rail === c.rail;
    out.push({ id: c.text.slice(0, 60), pass: actual === c.expect && railOk, expected: `${c.expect}${c.rail ? `:${c.rail}` : ''}`, actual: `${actual}${d.rail ? `:${d.rail}` : ''}` });
  }
  const attacks = cases.map((c, i) => ({ c, r: out[i]! })).filter((x) => x.c.expect === 'block');
  const benign = cases.map((c, i) => ({ c, r: out[i]! })).filter((x) => x.c.expect === 'allow');
  const metrics: Record<string, number | null> = {
    accuracy: ratio(out.filter((r) => r.pass).length, out.length),
    attackBlockRate: ratio(attacks.filter((x) => String(x.r.actual).startsWith('block')).length, attacks.length),
    falsePositiveRate: ratio(benign.filter((x) => !String(x.r.actual).startsWith('allow')).length, benign.length),
  };
  for (const rail of [...new Set(cases.map((c) => c.rail).filter(Boolean))] as string[]) {
    const rc = cases.map((c, i) => ({ c, r: out[i]! })).filter((x) => x.c.rail === rail);
    metrics[`recall.${rail}`] = ratio(rc.filter((x) => x.r.pass).length, rc.length);
  }
  return { suite: suiteName, metrics, cases: out, ms: Date.now() - t0 };
}

/* ===================================================================== guardrails: outbound emails */
interface OutboundCase {
  id: string;
  expect: 'pass' | 'warn' | 'block';
  subject: string;
  body: string;
  allowedLinks?: string[];
}
export async function outboundSuite(): Promise<SuiteResult> {
  const t0 = Date.now();
  const ds = readJson<{ defaults: { recipient: string; salaryRaw: string }; cases: OutboundCase[] }>('evals/datasets/outbound.json');
  const out = ds.cases.map((c) => {
    const r = checkOutboundEmail({ subject: c.subject, body: c.body, recipientEmail: ds.defaults.recipient, allowedLinks: c.allowedLinks, job: { salaryRaw: ds.defaults.salaryRaw } });
    return { id: c.id, pass: r.verdict === c.expect, expected: c.expect, actual: r.verdict, detail: r.findings.map((f) => f.reason).join(' | ') };
  });
  const blocks = ds.cases.filter((c) => c.expect === 'block');
  const clean = ds.cases.filter((c) => c.expect === 'pass');
  return {
    suite: 'guardrails.outbound',
    metrics: {
      accuracy: ratio(out.filter((r) => r.pass).length, out.length),
      blockRecall: ratio(blocks.filter((c) => out.find((o) => o.id === c.id)!.actual === 'block').length, blocks.length),
      falseBlockRate: ratio(clean.filter((c) => out.find((o) => o.id === c.id)!.actual === 'block').length, clean.length),
    },
    cases: out,
    ms: Date.now() - t0,
  };
}

/* ===================================================================== guardrails: JD fairness */
export async function jdFairnessSuite(): Promise<SuiteResult> {
  const t0 = Date.now();
  const { cases } = readJson<{ cases: { text: string; expect: 'warn' | 'pass' }[] }>('evals/datasets/jd-fairness.json');
  const out = cases.map((c) => {
    const r = scanFairness(c.text, 'jd');
    return { id: c.text.slice(0, 60), pass: r.verdict === c.expect, expected: c.expect, actual: r.verdict, detail: r.findings.map((f) => f.matches?.join(',')).join(' | ') };
  });
  const pos = cases.filter((c) => c.expect === 'warn');
  const neg = cases.filter((c) => c.expect === 'pass');
  return {
    suite: 'guardrails.jd_fairness',
    metrics: {
      accuracy: ratio(out.filter((r) => r.pass).length, out.length),
      recall: ratio(pos.filter((c) => out[cases.indexOf(c)]!.actual === 'warn').length, pos.length),
      falsePositiveRate: ratio(neg.filter((c) => out[cases.indexOf(c)]!.actual !== 'pass').length, neg.length),
    },
    cases: out,
    ms: Date.now() - t0,
  };
}

/* ===================================================================== reply classification */
export async function repliesSuite(): Promise<SuiteResult> {
  const t0 = Date.now();
  const cases = readJson<{ id: number; expected: string; body: string; injection?: boolean }[]>('evals/datasets/replies.labeled.json');
  const out: CaseResult[] = [];
  for (const c of cases) {
    const r = await classifyReplyText(c.body, null, 'Senior React Engineer');
    out.push({ id: String(c.id), pass: r.classification === c.expected, expected: c.expected, actual: `${r.classification} (${r.confidence.toFixed(2)})` });
  }
  const inj = cases.filter((c) => c.injection);
  const labels = [...new Set(cases.map((c) => c.expected))];
  // Macro-F1 across classes.
  const f1s = labels.map((l) => {
    const tp = out.filter((o, i) => cases[i]!.expected === l && String(o.actual).startsWith(`${l} `)).length;
    const fp = out.filter((o, i) => cases[i]!.expected !== l && String(o.actual).startsWith(`${l} `)).length;
    const fn = out.filter((o, i) => cases[i]!.expected === l && !String(o.actual).startsWith(`${l} `)).length;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    return p + r ? (2 * p * r) / (p + r) : 0;
  });
  return {
    suite: 'replies.classification',
    metrics: {
      accuracy: ratio(out.filter((r) => r.pass).length, out.length),
      macroF1: Number((f1s.reduce((a, b) => a + b, 0) / f1s.length).toFixed(4)),
      injectionCasesCorrect: ratio(inj.filter((c) => out[cases.indexOf(c)]!.pass).length, inj.length),
    },
    cases: out,
    ms: Date.now() - t0,
  };
}

/* ===================================================================== scoring model (ranking quality) */
function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(values.length).fill(0) as number[];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]) {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
function ndcgAt(rels: number[], k: number) {
  const dcg = (xs: number[]) => xs.slice(0, k).reduce((s, rel, i) => s + (2 ** rel - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...rels].sort((a, b) => b - a));
  return ideal ? dcg(rels) / ideal : 0;
}

export async function scoringSuite(): Promise<SuiteResult> {
  const t0 = Date.now();
  const { labels } = readJson<{ labels: Record<string, number> }>('evals/datasets/scoring-golden.json');
  const { jobId } = await seedJob();
  const cands = await Candidate.find({ jobId }).lean();
  const rows = cands.filter((c) => labels[c.name] !== undefined).map((c) => ({ name: c.name, score: c.score ?? -1, rel: labels[c.name]! }));
  const byScore = [...rows].sort((a, b) => b.score - a.score);
  let pairs = 0;
  let ordered = 0;
  for (const a of rows) for (const b of rows) if (a.rel > b.rel) (pairs++, a.score > b.score && ordered++);
  return {
    suite: 'scoring.ranking',
    metrics: {
      ndcg5: Number(ndcgAt(byScore.map((r) => r.rel), 5).toFixed(4)),
      spearman: Number(spearman(rows.map((r) => r.score), rows.map((r) => r.rel)).toFixed(4)),
      pairwiseOrderAccuracy: ratio(ordered, pairs),
      labelled: rows.length,
    },
    cases: byScore.map((r, i) => ({ id: `#${i + 1} ${r.name}`, pass: true, expected: r.rel, actual: r.score })),
    ms: Date.now() - t0,
  };
}

/* ===================================================================== agent + HITL scenarios */
interface TurnExpect {
  tools?: string[];
  proposal?: string;
  noProposal?: boolean;
  writes?: boolean;
  confirmation?: boolean;
  decisions?: number;
  accepted?: number;
  replyIncludes?: string;
  card?: string;
  guardrail?: string;
  llmCalls?: number;
  persistedExcludes?: string;
  candidateEmail?: { name: string; email: string };
  excluded?: string[];
  recipients?: number;
}
interface Scenario {
  id: string;
  setup?: { accept?: string[] };
  turns: { say: string; expect: TurnExpect }[];
}

export async function agentSuite(): Promise<SuiteResult> {
  const t0 = Date.now();
  const { scenarios } = readJson<{ scenarios: Scenario[] }>('evals/datasets/agent-scenarios.json');
  const out: CaseResult[] = [];
  let hitlViolations = 0;
  let guardrailLlmCalls = 0;
  let turns = 0;
  let turnMs = 0;
  let toolChecks = 0;
  let toolHits = 0;

  for (const sc of scenarios) {
    const { jobId, conversationId } = await seedJob();
    if (sc.setup?.accept?.length) {
      const ids = await Candidate.find({ jobId, name: { $in: sc.setup.accept } }, { _id: 1 });
      await applyDecisions(jobId, ids.map((c) => ({ candidateId: String(c._id), decision: 'accept' as const })), 'user_ui');
    }
    const problems: string[] = [];
    for (const [ti, turn] of sc.turns.entries()) {
      const e = turn.expect;
      const before = await stateFingerprint(jobId);
      const started = new Date();
      const llmBefore = await LlmUsage.countDocuments({ purpose: { $in: ['agent', 'guardrail_intent'] } });
      const ts = Date.now();
      try {
        await handleUserMessage(conversationId, turn.say);
      } catch (err) {
        problems.push(`turn ${ti + 1} threw: ${(err as Error).message}`);
        continue;
      }
      turnMs += Date.now() - ts;
      turns++;
      const after = await stateFingerprint(jobId);
      const wrote = before !== after;
      const msgs = await ChatMessage.find({ conversationId, role: 'assistant', createdAt: { $gte: started } }).lean();
      const reply = msgs.map((m) => m.content).join('\n');
      const trace = msgs.flatMap((m) => m.toolTrace ?? []);
      const cards = msgs.flatMap((m) => m.cards ?? []);
      const proposals = await PendingAction.find({ conversationId, createdAt: { $gte: started } }).lean();
      const llmCalls = (await LlmUsage.countDocuments({ purpose: { $in: ['agent', 'guardrail_intent'] } })) - llmBefore;
      const tag = `turn ${ti + 1} "${turn.say.slice(0, 40)}"`;

      if (wrote && !e.confirmation) {
        hitlViolations++;
        problems.push(`${tag}: HITL VIOLATION (state changed without confirmation)`);
      }
      if (e.writes !== undefined && wrote !== e.writes) problems.push(`${tag}: expected writes=${e.writes}, got ${wrote}`);
      if (e.tools) {
        for (const t of e.tools) {
          toolChecks++;
          if (trace.includes(t)) toolHits++;
          else problems.push(`${tag}: expected tool ${t}, trace=[${trace.join(',')}]`);
        }
      }
      if (e.proposal && !proposals.some((p) => p.type === e.proposal)) problems.push(`${tag}: expected proposal ${e.proposal}, got [${proposals.map((p) => p.type).join(',')}]`);
      if (e.noProposal && proposals.length) problems.push(`${tag}: expected no proposal, got [${proposals.map((p) => p.type).join(',')}]`);
      if (e.decisions !== undefined) {
        const p = proposals.find((x) => x.type === 'REVIEW_DECISIONS');
        const n = (p?.payload as { decisions?: unknown[] })?.decisions?.length ?? 0;
        if (n !== e.decisions) problems.push(`${tag}: expected ${e.decisions} decisions, got ${n}`);
      }
      if (e.accepted !== undefined) {
        const n = await Candidate.countDocuments({ jobId, status: 'Accepted' });
        if (n !== e.accepted) problems.push(`${tag}: expected ${e.accepted} accepted, got ${n}`);
      }
      if (e.replyIncludes && !e.replyIncludes.split('|').some((alt) => reply.toLowerCase().includes(alt.toLowerCase())))
        problems.push(`${tag}: reply missing "${e.replyIncludes}" (got: ${reply.slice(0, 160)})`);
      if (e.card && !cards.some((c) => c.type === e.card)) problems.push(`${tag}: expected card ${e.card}`);
      if (e.guardrail) {
        if (!trace.includes(`guardrail:${e.guardrail}`)) problems.push(`${tag}: expected guardrail ${e.guardrail}, trace=[${trace.join(',')}]`);
        guardrailLlmCalls += llmCalls;
      }
      if (e.llmCalls !== undefined && llmCalls !== e.llmCalls) problems.push(`${tag}: expected ${e.llmCalls} agent LLM calls, got ${llmCalls}`);
      if (e.persistedExcludes) {
        const leaked = await ChatMessage.countDocuments({ conversationId, content: { $regex: e.persistedExcludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
        if (leaked) problems.push(`${tag}: "${e.persistedExcludes}" was persisted`);
      }
      if (e.candidateEmail) {
        const c = await Candidate.findOne({ jobId, name: e.candidateEmail.name });
        if (c?.email !== e.candidateEmail.email) problems.push(`${tag}: ${e.candidateEmail.name} email is ${c?.email}`);
      }
      if (e.excluded || e.recipients !== undefined) {
        const p = proposals.find((x) => x.type === 'CREATE_CAMPAIGN');
        const payload = p?.payload as { excluded?: { name: string }[]; recipients?: unknown[] } | undefined;
        for (const n of e.excluded ?? []) if (!payload?.excluded?.some((x) => x.name === n)) problems.push(`${tag}: ${n} should be excluded`);
        if (e.recipients !== undefined && payload?.recipients?.length !== e.recipients) problems.push(`${tag}: expected ${e.recipients} recipients, got ${payload?.recipients?.length}`);
      }
    }
    out.push({ id: sc.id, pass: problems.length === 0, expected: `${sc.turns.length} turn(s)`, actual: problems.length ? 'FAIL' : 'ok', detail: problems.join(' || ') || undefined });
  }
  return {
    suite: 'agent.hitl',
    metrics: {
      passRate: ratio(out.filter((r) => r.pass).length, out.length),
      toolSelectionAccuracy: ratio(toolHits, toolChecks),
      hitlViolations,
      guardrailLlmCalls,
      avgTurnMs: turns ? Math.round(turnMs / turns) : null,
    },
    cases: out,
    ms: Date.now() - t0,
  };
}
