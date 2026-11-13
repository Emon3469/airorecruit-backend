import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppSetting } from '../models';

/**
 * Email transport:
 *  1. SMTP_* configured  → real SMTP (Mailtrap, Gmail app password, etc.)
 *  2. otherwise          → auto-created Ethereal test inbox (real SMTP, nothing is delivered;
 *                          every send returns a preview URL you can open in the browser).
 *                          The account is stored in Mongo so API and workers share one inbox.
 *  3. Ethereal unreachable (offline) → JSON transport: the email is logged, not sent.
 */
export interface SendResult {
  messageId: string;
  previewUrl: string | null;
  transport: 'smtp' | 'ethereal' | 'log';
}

let transporter: Transporter | null = null;
let mode: SendResult['transport'] = 'log';

async function getTransport(): Promise<Transporter> {
  if (transporter) return transporter;
  if (env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    mode = 'smtp';
    return transporter;
  }
  try {
    let account = (await AppSetting.findOne({ key: 'ethereal' }).lean())?.value as { user: string; pass: string } | undefined;
    if (!account) {
      const created = await nodemailer.createTestAccount();
      account = { user: created.user, pass: created.pass };
      // Upsert: if another process created one concurrently, keep the first.
      await AppSetting.updateOne({ key: 'ethereal' }, { $setOnInsert: { value: account } }, { upsert: true });
      account = ((await AppSetting.findOne({ key: 'ethereal' }).lean())?.value as typeof account) ?? account;
    }
    transporter = nodemailer.createTransport({ host: 'smtp.ethereal.email', port: 587, secure: false, auth: account });
    mode = 'ethereal';
    logger.info({ user: account.user }, 'using Ethereal test inbox (log in at https://ethereal.email with these credentials)');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Ethereal unavailable, emails will only be logged');
    transporter = nodemailer.createTransport({ jsonTransport: true });
    mode = 'log';
  }
  return transporter;
}

export function senderName(): string {
  const m = env.MAIL_FROM.match(/^\s*"?([^"<]+?)"?\s*</);
  return m?.[1]?.trim() ?? 'The Talent Team';
}

export function fillPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

export async function sendEmail(input: { to: string; subject: string; text: string; headers?: Record<string, string> }): Promise<SendResult> {
  const t = await getTransport();
  const info = await t.sendMail({
    from: env.MAIL_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
    headers: { 'X-Mailer': 'AiroRecruit', ...(input.headers ?? {}) },
  });
  const previewUrl = mode === 'ethereal' ? (nodemailer.getTestMessageUrl(info) || null) : null;
  if (mode === 'log') logger.info({ to: input.to, subject: input.subject }, 'email logged (no transport)');
  return { messageId: info.messageId ?? `log-${Date.now()}`, previewUrl, transport: mode };
}

/** Test hook. */
export function setTransportForTests(t: Transporter, m: SendResult['transport'] = 'log') {
  transporter = t;
  mode = m;
}
