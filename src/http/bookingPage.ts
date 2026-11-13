import { Router } from 'express';
import { ah } from './middleware';
import { chooseSlot, getBookingView } from '../services/booking.service';
import { AppError } from '../lib/errors';

/**
 * Server-rendered fallback for the mock time-slot picker, so booking links work even
 * without the frontend running. The React app has its own /booking/:token page.
 */
export const bookingPageRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, inner: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7fb;--card:#fff;--ink:#111827;--muted:#6b7280;--accent:#4f46e5;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#151821;--ink:#f3f4f6;--muted:#9ca3af;--line:#262a36}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;max-width:440px;width:100%}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
form{display:grid;gap:10px}button{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;text-align:left}
button:hover{border-color:var(--accent)}.ok{color:#16a34a;font-weight:600}</style></head><body><div class="card">${inner}</div></body></html>`;
}

function fmt(iso: string) {
  return new Date(iso).toUTCString().replace(':00 GMT', ' UTC');
}

bookingPageRouter.get(
  '/booking/:token',
  ah(async (req, res) => {
    try {
      const v = await getBookingView(String(req.params.token));
      if (v.chosenSlot) {
        res.send(page('Booked', `<h1>You're booked, ${esc(v.candidateFirstName)}!</h1><p class="ok">${esc(fmt(v.chosenSlot))}</p><p>We look forward to talking about the ${esc(v.jobTitle)} role.</p>`));
        return;
      }
      const buttons = v.slots.map((s) => `<button name="slot" value="${esc(s)}">${esc(fmt(s))}</button>`).join('');
      res.send(page('Pick a time', `<h1>Hi ${esc(v.candidateFirstName)}, pick a time</h1><p>30-minute intro call about the ${esc(v.jobTitle)} role${v.company ? ` at ${esc(v.company)}` : ''}.</p><form method="post">${buttons}</form>`));
    } catch (err) {
      res.status(err instanceof AppError ? err.status : 500).send(page('Not found', '<h1>This booking link is not valid.</h1>'));
    }
  }),
);

bookingPageRouter.post(
  '/booking/:token',
  ah(async (req, res) => {
    try {
      await chooseSlot(String(req.params.token), String(req.body?.slot ?? ''));
      res.redirect(303, `/booking/${encodeURIComponent(String(req.params.token))}`);
    } catch (err) {
      res.status(err instanceof AppError ? err.status : 500).send(page('Error', `<h1>${esc(err instanceof AppError ? err.message : 'Something went wrong')}</h1>`));
    }
  }),
);
