'use strict';

const nodemailer = require('nodemailer');
const { pool } = require('./db');
const rid = require('./requestid');

/**
 * Outbound email.
 *
 * Provider-agnostic on purpose: SMTP covers every host on earth, and the three
 * HTTP providers are there because they are what people actually reach for.
 * Set EMAIL_PROVIDER and the matching credentials; nothing else changes.
 *
 *   smtp     — any SMTP host (Zoho, Google Workspace, Amazon SES SMTP, Mailgun…)
 *   resend   — RESEND_API_KEY
 *   postmark — POSTMARK_TOKEN
 *   sendgrid — SENDGRID_API_KEY
 *   console  — development; prints to stdout and never sends
 *
 * Every send is logged to email_log, so "did they get the invite?" is a query
 * rather than a trip into the provider dashboard.
 */

const PROVIDER = process.env.EMAIL_PROVIDER || 'console';
const FROM = process.env.EMAIL_FROM || 'Hydra <no-reply@mail.thinkvisor.io>';
const REPLY_TO = process.env.EMAIL_REPLY_TO || null;
const ORIGIN = process.env.CONSOLE_ORIGIN || 'https://app.thinkvisor.io';

let smtp = null;
function smtpTransport() {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  }
  return smtp;
}

const providers = {
  async console({ to, subject, text }) {
    rid.info('email.console', { to, subject });
    console.log(`\n--- EMAIL to ${to} ---\n${subject}\n\n${text}\n---\n`);
    return { id: 'console' };
  },

  async smtp({ to, subject, html, text }) {
    const info = await smtpTransport().sendMail({
      from: FROM, to, subject, text, html,
      replyTo: REPLY_TO || undefined
    });
    return { id: info.messageId };
  },

  async resend({ to, subject, html, text }) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text,
                             reply_to: REPLY_TO || undefined })
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
    return { id: (await r.json()).id };
  },

  async postmark({ to, subject, html, text }) {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'X-Postmark-Server-Token': process.env.POSTMARK_TOKEN },
      body: JSON.stringify({ From: FROM, To: to, Subject: subject,
                             HtmlBody: html, TextBody: text,
                             ReplyTo: REPLY_TO || undefined,
                             MessageStream: process.env.POSTMARK_STREAM || 'outbound' })
    });
    if (!r.ok) throw new Error(`postmark ${r.status}: ${await r.text()}`);
    return { id: (await r.json()).MessageID };
  },

  async sendgrid({ to, subject, html, text }) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parseFrom(FROM),
        subject,
        content: [{ type: 'text/plain', value: text },
                  { type: 'text/html', value: html }]
      })
    });
    if (!r.ok) throw new Error(`sendgrid ${r.status}: ${await r.text()}`);
    return { id: r.headers.get('x-message-id') };
  }
};

function parseFrom(s) {
  const m = s.match(/^(.*)<(.+)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { email: s };
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const layout = (body) => `<!doctype html>
<html><body style="margin:0;background:#fbfaf8;font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1c1c1a">
<div style="max-width:520px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e3e1db;border-radius:12px">
<div style="font-size:18px;font-weight:500;margin-bottom:24px">Hydra</div>
${body}
<hr style="border:0;border-top:1px solid #e3e1db;margin:28px 0">
<p style="font-size:12px;color:#6b6a65;margin:0">
Hydra AI merchandising. If you weren't expecting this, you can ignore it.
</p></div></body></html>`;

const btn = (url, label) =>
  `<p style="margin:24px 0"><a href="${url}" style="background:#3f3a8c;color:#fff;
   padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">${label}</a></p>`;

const TEMPLATES = {
  password_reset: ({ url, name }) => ({
    subject: 'Reset your Hydra password',
    text: `Hello${name ? ' ' + name : ''},\n\nReset your password:\n${url}\n\n`
        + `This link expires in 30 minutes and works once.\n\n`
        + `If you didn't ask for this, ignore this email — your password is unchanged.`,
    html: layout(`<p>Hello${name ? ' ' + name : ''},</p>
      <p>Use the link below to set a new password.</p>${btn(url, 'Reset password')}
      <p style="font-size:14px;color:#6b6a65">Expires in 30 minutes and works once.
      If you didn't ask for this, ignore it — your password is unchanged.</p>`)
  }),

  password_changed: ({ name, ip }) => ({
    subject: 'Your Hydra password was changed',
    text: `Hello${name ? ' ' + name : ''},\n\nYour password was just changed`
        + `${ip ? ` from ${ip}` : ''}. All other sessions have been signed out.\n\n`
        + `If this wasn't you, contact support immediately.`,
    html: layout(`<p>Hello${name ? ' ' + name : ''},</p>
      <p>Your password was just changed${ip ? ` from <code>${ip}</code>` : ''}.
      All other sessions have been signed out.</p>
      <p style="font-size:14px;color:#6b6a65">If this wasn't you, contact support immediately.</p>`)
  }),

  user_invited: ({ url, inviter, company, role }) => ({
    subject: `${inviter} invited you to ${company} on Hydra`,
    text: `${inviter} has invited you to join ${company} on Hydra as ${role}.\n\n`
        + `${url}\n\nThis invite expires in 7 days.`,
    html: layout(`<p><strong>${inviter}</strong> invited you to join
      <strong>${company}</strong> on Hydra as <strong>${role}</strong>.</p>
      ${btn(url, 'Accept invite')}
      <p style="font-size:14px;color:#6b6a65">Expires in 7 days.</p>`)
  }),

  welcome: ({ name, publishableKey }) => ({
    subject: 'Your Hydra sandbox is ready',
    text: `Welcome${name ? ' ' + name : ''}.\n\nYour sandbox is live. `
        + `Publishable key: ${publishableKey}\n\n`
        + `Your secret key was shown once at signup and is not repeated here for `
        + `security. Rotate it from the console if you no longer have it.\n\n`
        + `Next: install the cartridge or Shopify app, then run discovery.\n${ORIGIN}`,
    html: layout(`<p>Welcome${name ? ' ' + name : ''}.</p>
      <p>Your sandbox is live. Publishable key:</p>
      <p><code style="background:#f1efe8;padding:8px;border-radius:6px;display:block;
         word-break:break-all">${publishableKey}</code></p>
      <p style="font-size:14px;color:#6b6a65">Your secret key was shown once at signup
      and is deliberately not repeated here. Rotate it from the console if you no
      longer have it.</p>${btn(ORIGIN, 'Open the console')}`)
  }),

  quota_warning: ({ pct, used, cap, company }) => ({
    subject: pct >= 100
      ? `${company} has reached its Hydra query limit`
      : `${company} is at ${pct}% of its Hydra query limit`,
    text: `${used.toLocaleString()} of ${cap.toLocaleString()} queries used this month.\n\n`
        + (pct >= 100
            ? `Further queries fall back to your native search — your storefront is `
            + `not affected. Buy a credit block or upgrade to restore Hydra results.\n\n`
            : `No action needed yet.\n\n`)
        + `${ORIGIN}/billing`,
    html: layout(`<p><strong>${used.toLocaleString()}</strong> of
      ${cap.toLocaleString()} queries used this month.</p>
      <p>${pct >= 100
        ? 'Further queries fall back to your native search, so your storefront is '
        + 'not affected. Buy a credit block or upgrade to restore Hydra results.'
        : 'No action needed yet.'}</p>${btn(ORIGIN + '/billing', 'View billing')}`)
  }),

  sync_failed: ({ site, error }) => ({
    subject: `Hydra catalog sync failed for ${site}`,
    text: `The catalog sync for ${site} failed:\n\n${error}\n\n`
        + `Your storefront is unaffected — Hydra continues serving the last `
        + `successful catalog.\n\n${ORIGIN}/syncs`,
    html: layout(`<p>The catalog sync for <strong>${site}</strong> failed.</p>
      <p><code style="background:#fcebeb;padding:8px;border-radius:6px;display:block">
      ${error}</code></p>
      <p>Your storefront is unaffected — Hydra keeps serving the last successful
      catalog.</p>${btn(ORIGIN + '/syncs', 'View syncs')}`)
  })
};

/* ------------------------------------------------------------------ */

async function send(template, to, data, { tenantId = null } = {}) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template ${template}`);
  const { subject, html, text } = t(data);

  // Never send to an address that has hard-bounced or complained — repeat
  // sends to bad addresses are how a sending domain's reputation dies.
  const { rows: sup } = await pool.query(
    'SELECT 1 FROM email_suppressions WHERE email = $1', [to]);
  if (sup.length) {
    await logEmail({ tenantId, to, template, subject, status: 'suppressed' });
    rid.warn('email.suppressed', { to, template });
    return { ok: false, suppressed: true };
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO email_log (tenant_id, to_email, template, subject, provider,
                            status, request_id)
     VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING id`,
    [tenantId, to, template, subject, PROVIDER, rid.currentId()]);

  try {
    const result = await providers[PROVIDER]({ to, subject, html, text });
    await pool.query(
      `UPDATE email_log SET status='sent', provider_id=$2, sent_at=now() WHERE id=$1`,
      [row.id, result?.id || null]);
    rid.info('email.sent', { to, template, provider: PROVIDER });
    return { ok: true };
  } catch (e) {
    await pool.query(
      `UPDATE email_log SET status='failed', error=$2 WHERE id=$1`,
      [row.id, e.message.slice(0, 500)]);
    // Never throw. A failed invite email must not roll back the invite itself —
    // the link is still visible in the console as a fallback.
    rid.error('email.failed', { to, template, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function logEmail({ tenantId, to, template, subject, status }) {
  await pool.query(
    `INSERT INTO email_log (tenant_id, to_email, template, subject, provider, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, to, template, subject, PROVIDER, status]);
}

module.exports = { send, TEMPLATES, PROVIDER };
