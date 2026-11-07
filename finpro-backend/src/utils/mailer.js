/**
 * Minimal transactional email sender using Resend's HTTP API (no extra npm
 * dependency — Node 18+ has fetch built in).
 *
 * Env vars (set on Render, unquoted):
 *   RESEND_API_KEY      your Resend API key
 *   MAIL_FROM           e.g.  FinProMatch <onboarding@resend.dev>   (works for testing)
 *                       once you verify a domain:  FinProMatch <notifications@yourdomain.com>
 *   MAIL_REPLY_TO       optional, e.g. finpromatch@gmail.com
 *   APP_URL             https://finpromatch.vercel.app
 *   ADMIN_NOTIFY_EMAIL  where admin alerts go (default finpromatch@gmail.com)
 *
 * IMPORTANT: sendMail never throws. A failed email must never break the
 * request that triggered it.
 */
const APP_URL = (process.env.APP_URL || 'https://finpromatch.vercel.app').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'finpromatch@gmail.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout({ heading, bodyHtml, ctaLabel, ctaUrl }) {
  return `<!doctype html><html><body style="margin:0;background:#F6F5F1;font-family:Arial,Helvetica,sans-serif;color:#071426;">
  <div style="max-width:560px;margin:0 auto;padding:28px 18px;">
    <div style="font-weight:800;font-size:20px;margin-bottom:18px;">FinPro<span style="color:#0E9F6E;">Match</span></div>
    <div style="background:#fff;border:1px solid #E3E1DA;border-radius:12px;padding:26px;">
      <h2 style="margin:0 0 12px;font-size:20px;">${esc(heading)}</h2>
      <div style="font-size:15px;line-height:1.6;color:#364452;">${bodyHtml}</div>
      ${ctaUrl ? `<p style="margin:22px 0 0;"><a href="${esc(ctaUrl)}" style="background:#0B7A54;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px;display:inline-block;">${esc(ctaLabel || 'Open FinProMatch')}</a></p>` : ''}
    </div>
    <p style="font-size:12px;color:#6B7785;margin:16px 4px;">You are receiving this because of activity on your FinProMatch account. Questions? Reply to this email or write to finpromatch@gmail.com.</p>
  </div></body></html>`;
}

async function sendMail({ to, subject, heading, bodyHtml, ctaLabel, ctaUrl }) {
  try {
    const recipients = [].concat(to || []).filter(Boolean);
    if (!recipients.length) return false;
    if (!process.env.RESEND_API_KEY) {
      console.warn('[mailer] RESEND_API_KEY not set — skipped email:', subject, '->', recipients.join(', '));
      return false;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'FinProMatch <onboarding@resend.dev>',
        to: recipients,
        reply_to: process.env.MAIL_REPLY_TO || undefined,
        subject,
        html: layout({ heading: heading || subject, bodyHtml, ctaLabel, ctaUrl }),
      }),
    });
    if (!res.ok) {
      console.error('[mailer] Resend error', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mailer] failed:', err.message);
    return false;
  }
}

module.exports = { sendMail, esc, APP_URL, ADMIN_EMAIL };