/** npm run serper:smoke: real Serper queries (raw + through the production parser). Key never printed. */
import { env } from '../src/config/env';
import { buildSearchQuery, searchSerper } from '../src/services/sourcing.service';

async function raw(q: string) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 10 }),
  });
  const j = (await res.json()) as { organic?: { title: string; link: string }[]; message?: string };
  return { status: res.status, message: j.message, organic: j.organic ?? [] };
}

(async () => {
  if (!env.SERPER_API_KEY) throw new Error('SERPER_API_KEY not configured');
  const queries = [
    buildSearchQuery({ title: 'Senior React Engineer (Frontend Platform)', location: 'Dhaka, Bangladesh', mustHaveSkills: ['React', 'TypeScript'], remotePolicy: 'hybrid' } as never),
    'site:linkedin.com/in React Engineer Dhaka',
  ];
  for (const q of queries) {
    const r = await raw(q);
    console.log(`\nquery: ${q}\n  HTTP ${r.status}${r.message ? ` (${r.message})` : ''}, raw organic=${r.organic.length}`);
    for (const o of r.organic.slice(0, 4)) console.log(`   raw: ${o.title} | ${o.link}`);
    const rows = await searchSerper(q, 10);
    console.log(`  parsed profiles=${rows.length}`);
    for (const p of rows.slice(0, 4)) console.log(`   ✓ ${p.name} | ${p.headline ?? '-'} | email=${p.email ?? 'null'}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('SERPER FAILED:', (e as Error).message.slice(0, 300));
  process.exit(1);
});
