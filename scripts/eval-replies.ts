/**
 * npm run eval:replies
 * Runs 20 labelled candidate replies (incl. 3 prompt-injection attempts and 2 ambiguous ones)
 * through the production classifier and prints accuracy + a confusion matrix.
 * Works with any provider; with no key it evaluates the deterministic heuristic fallback.
 * MongoDB is optional (usage logging is skipped if it isn't reachable).
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { classifyReplyText } from '../src/services/reply.service';
import { llmInfo } from '../src/llm';
import { scanForInjection } from '../src/domain/untrusted';
import { REPLY_CLASSES } from '../src/models';

interface Case {
  id: number;
  expected: (typeof REPLY_CLASSES)[number];
  body: string;
  ambiguous?: boolean;
  injection?: boolean;
}

async function main() {
  mongoose.set('bufferCommands', false); // don't block on usage logging without a DB
  const cases: Case[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'datasets', 'replies.labeled.json'), 'utf8'));
  const labels = [...REPLY_CLASSES];
  const matrix: Record<string, Record<string, number>> = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
  let correct = 0;
  const rows: string[] = [];
  for (const c of cases) {
    const res = await classifyReplyText(c.body, null, 'Senior React Engineer');
    matrix[c.expected]![res.classification]!++;
    const ok = res.classification === c.expected;
    if (ok) correct++;
    const flag = scanForInjection(c.body).flagged;
    rows.push(
      `${String(c.id).padStart(2)} ${ok ? 'PASS' : 'FAIL'}  expected=${c.expected.padEnd(14)} got=${res.classification.padEnd(14)} conf=${res.confidence.toFixed(2)}${c.injection ? `  [injection${flag ? ', flagged' : ', NOT flagged'}]` : ''}${c.ambiguous ? '  [ambiguous]' : ''}`,
    );
  }
  console.log(`\nReply classification eval (provider=${llmInfo.provider}, model=${llmInfo.models.fast})\n`);
  console.log(rows.join('\n'));
  const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(0)}%`;
  console.log(`\nOverall accuracy: ${correct}/${cases.length} (${pct(correct, cases.length)})`);
  const inj = cases.filter((c) => c.injection);
  console.log(`Injection cases flagged by heuristic scan: ${inj.filter((c) => scanForInjection(c.body).flagged).length}/${inj.length}`);

  console.log('\nPer-class accuracy:');
  for (const l of labels) {
    const total = Object.values(matrix[l]!).reduce((a, b) => a + b, 0);
    console.log(`  ${l.padEnd(15)} ${total ? `${matrix[l]![l]}/${total} (${pct(matrix[l]![l]!, total)})` : 'n/a'}`);
  }
  console.log('\nConfusion matrix (rows = expected, cols = predicted):');
  const short = (s: string) => s.slice(0, 10).padStart(11);
  console.log(`${''.padEnd(15)}${labels.map(short).join('')}`);
  for (const a of labels) console.log(`${a.padEnd(15)}${labels.map((b) => String(matrix[a]![b]).padStart(11)).join('')}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
