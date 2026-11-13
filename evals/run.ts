/**
 * npm run eval            → run all suites, record the experiment, enforce the quality gate
 * npm run eval -- --suite=guardrails.input,agent.hitl
 * npm run eval -- --update-baseline   → accept current metrics as the new baseline floor
 *
 * LLMOps/MLOps without Docker:
 *  - Infra: mongodb-memory-server + in-memory queue adapter running the real worker code.
 *  - Experiment tracking: every run is appended to evals/results/history.jsonl with git SHA, provider,
 *    models, prompt-version hashes and dataset hashes, so any metric change is attributable.
 *  - Quality gate: evals/baseline.json holds min/max thresholds; the process exits 1 on regression (CI).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { env } from '../src/config/env';
import { llmInfo, promptVersion } from '../src/llm';
import * as prompts from '../src/llm/prompts';
import { getStack, ROOT } from './lib/stack';
import { agentSuite, guardrailInputSuite, jdFairnessSuite, outboundSuite, repliesSuite, scoringSuite, type SuiteResult } from './suites';

const SUITES: Record<string, () => Promise<SuiteResult>> = {
  'guardrails.input': () => guardrailInputSuite(),
  /** Held-out paraphrases never used for tuning: reported, not gated. */
  'guardrails.holdout': () => guardrailInputSuite('evals/datasets/guardrails.holdout.json', 'guardrails.holdout'),
  'guardrails.outbound': outboundSuite,
  'guardrails.jd_fairness': jdFairnessSuite,
  'replies.classification': repliesSuite,
  'scoring.ranking': scoringSuite,
  'agent.hitl': agentSuite,
};

type Gate = Record<string, { min?: number; max?: number }>;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}`));
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

function gitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  const selected = arg('suite')?.split('=')[1]?.split(',') ?? Object.keys(SUITES);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${env.llmProvider}`;
  console.log(`\nAiroRecruit eval run ${runId}\nprovider=${llmInfo.provider} agent=${llmInfo.models.agent} fast=${llmInfo.models.fast}\n`);

  await getStack();
  const results: SuiteResult[] = [];
  for (const name of selected) {
    const fn = SUITES[name];
    if (!fn) throw new Error(`Unknown suite ${name}`);
    process.stdout.write(`- ${name} ... `);
    let r: SuiteResult;
    try {
      r = await fn();
    } catch (err) {
      // A provider outage must not hide the other suites' results; the gate still fails below.
      r = { suite: name, metrics: { error: 1 }, cases: [{ id: 'suite crashed', pass: false, expected: 'completed', actual: (err as Error).message.slice(0, 200) }], ms: 0 };
    }
    results.push(r);
    const failed = r.cases.filter((c) => !c.pass).length;
    console.log(`${r.cases.length - failed}/${r.cases.length} cases  ${JSON.stringify(r.metrics)}  (${r.ms} ms)`);
    for (const c of r.cases.filter((x) => !x.pass)) console.log(`    FAIL ${c.id}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}${c.detail ? `  ${c.detail}` : ''}`);
  }

  // ---------------------------------------------------------------- experiment record
  const datasets = fs.readdirSync(path.join(ROOT, 'evals', 'datasets')).sort();
  const flat: Record<string, number | null> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.metrics)) flat[`${r.suite}.${k}`] = v;
  const record = {
    runId,
    at: new Date().toISOString(),
    gitSha: gitSha(),
    provider: llmInfo.provider,
    models: llmInfo.models,
    promptVersions: Object.fromEntries(
      Object.entries(prompts)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, promptVersion(v as string)]),
    ),
    datasetHashes: Object.fromEntries(datasets.map((d) => [d, sha(fs.readFileSync(path.join(ROOT, 'evals', 'datasets', d), 'utf8'))])),
    metrics: flat,
  };

  // ---------------------------------------------------------------- quality gate
  // Baselines are per provider: a real model is never gated against thresholds measured on the offline rules.
  const baselinePath = path.join(ROOT, 'evals', `baseline.${record.provider}.json`);
  const gate: Gate = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).thresholds : {};
  const violations: string[] = results.filter((r) => r.metrics.error).map((r) => `${r.suite}: suite crashed (${String(r.cases[0]?.actual)})`);
  for (const [metric, t] of Object.entries(gate)) {
    const v = flat[metric];
    if (v === undefined) continue; // suite not selected this run
    if (v === null) violations.push(`${metric}: no value`);
    else if (t.min !== undefined && v < t.min) violations.push(`${metric}: ${v} < min ${t.min}`);
    else if (t.max !== undefined && v > t.max) violations.push(`${metric}: ${v} > max ${t.max}`);
  }

  // Deltas vs the previous run with the same provider (regression visibility).
  const resultsDir = path.join(ROOT, 'evals', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const historyPath = path.join(resultsDir, 'history.jsonl');
  const history = fs.existsSync(historyPath)
    ? fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as typeof record)
    : [];
  const prev = [...history].reverse().find((h) => h.provider === record.provider);
  const deltas = prev
    ? Object.fromEntries(Object.entries(flat).filter(([k, v]) => typeof v === 'number' && typeof prev.metrics[k] === 'number' && v !== prev.metrics[k]).map(([k, v]) => [k, Number(((v as number) - (prev.metrics[k] as number)).toFixed(4))]))
    : {};

  const full = { ...record, gate: { passed: violations.length === 0, violations }, deltasVsPrevious: deltas, results };
  fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify(full, null, 2));
  fs.appendFileSync(historyPath, `${JSON.stringify({ ...record, gatePassed: violations.length === 0 })}\n`);
  fs.writeFileSync(path.join(resultsDir, 'latest.md'), renderMarkdown(full));

  if (arg('update-baseline')) {
    const thresholds: Gate = {};
    for (const [k, v] of Object.entries(flat)) {
      if (typeof v !== 'number' || k.startsWith('guardrails.holdout')) continue;
      if (/falsePositiveRate|falseBlockRate|hitlViolations|guardrailLlmCalls/.test(k)) thresholds[k] = { max: v };
      else if (/accuracy|Rate$|recall|ndcg|spearman|macroF1|passRate|Correct/.test(k)) thresholds[k] = { min: Number(Math.max(0, v - 0.02).toFixed(4)) };
    }
    fs.writeFileSync(baselinePath, JSON.stringify({ updatedAt: record.at, fromRun: runId, provider: record.provider, thresholds }, null, 2));
    console.log(`\nBaseline updated → evals/baseline.json`);
  }

  console.log(`\nResults → evals/results/${runId}.json, evals/results/latest.md, history.jsonl`);
  if (Object.keys(deltas).length) console.log(`Changes vs previous ${record.provider} run: ${JSON.stringify(deltas)}`);
  if (violations.length) {
    console.log(`\nQUALITY GATE FAILED:\n  ${violations.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nQuality gate passed.');
  process.exit(0);
}

function renderMarkdown(r: { runId: string; provider: string; models: unknown; gitSha: string | null; gate: { passed: boolean; violations: string[] }; results: SuiteResult[] }) {
  const lines = [
    `# Eval run ${r.runId}`,
    '',
    `provider \`${r.provider}\` · models \`${JSON.stringify(r.models)}\` · git \`${r.gitSha ?? 'n/a'}\` · gate **${r.gate.passed ? 'PASSED' : 'FAILED'}**`,
    '',
    '| Suite | Cases | Metrics |',
    '|---|---|---|',
    ...r.results.map((s) => `| ${s.suite} | ${s.cases.filter((c) => c.pass).length}/${s.cases.length} | ${Object.entries(s.metrics).map(([k, v]) => `${k}=${v}`).join(', ')} |`),
    '',
  ];
  const failures = r.results.flatMap((s) => s.cases.filter((c) => !c.pass).map((c) => `- **${s.suite}** ${c.id}: expected \`${JSON.stringify(c.expected)}\`, got \`${JSON.stringify(c.actual)}\`${c.detail ? `. ${c.detail}` : ''}`));
  if (failures.length) lines.push('## Failures', '', ...failures, '');
  if (r.gate.violations.length) lines.push('## Gate violations', '', ...r.gate.violations.map((v) => `- ${v}`), '');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
