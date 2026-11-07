/**
 * Every email FinProMatch sends, in one place. Each function takes ids,
 * loads what it needs, and sends. Wrapped by middleware/notifyHooks.js so
 * existing routes don't need editing.
 *
 * Privacy: client contact details are never put in an email. Emails say
 * "something changed" and link to the portal, where the existing
 * visibility rules (contact unlocks at payment) still apply.
 */
const prisma = require('../db');
const { sendMail, esc, APP_URL, ADMIN_EMAIL } = require('./mailer');

const sent = new Set(); // simple in-memory de-dupe for events that can fire twice (e.g. payment verify)
function once(key) {
  if (sent.has(key)) return false;
  sent.add(key);
  if (sent.size > 5000) sent.clear();
  return true;
}

const job = (e) => `<strong>${esc(e.engagementType)}</strong> (ref ${esc(e.refCode)})`;
const getEng = (id) => prisma.engagement.findUnique({ where: { id } });
async function firmsOf(eng) {
  if (!eng.selectedFirmIds || !eng.selectedFirmIds.length) return [];
  return prisma.firm.findMany({ where: { id: { in: eng.selectedFirmIds } } });
}
const firmEmails = (firms) => firms.map((f) => f.email);

async function newEngagement(id) {
  const e = await getEng(id); if (!e) return;
  await sendMail({ to: ADMIN_EMAIL, subject: `New engagement request: ${e.engagementType}`,
    bodyHtml: `<p>A new request from ${esc(e.clientName)} needs matching.</p><p>${job(e)}</p>`, ctaLabel: 'Open admin', ctaUrl: `${APP_URL}/#admin` });
  await sendMail({ to: e.clientEmail, subject: 'We received your request',
    bodyHtml: `<p>Thanks, ${esc(e.clientName)}. We have your request ${job(e)}.</p><p>A person on our team will review it and choose a suitable firm. We will email you as soon as a firm is selected.</p>`,
    ctaLabel: 'View your request', ctaUrl: `${APP_URL}/#client` });
}

async function matched(id) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  await sendMail({ to: firmEmails(firms), subject: 'New engagement matched to your firm',
    bodyHtml: `<p>FinProMatch has matched your firm to a new engagement: ${job(e)}.</p>${e.matchReasonNote ? `<p><strong>Why we matched you:</strong> ${esc(e.matchReasonNote)}</p>` : ''}<p>Log in to review the details. The client has been asked to accept the introduction first.</p>`,
    ctaLabel: 'Open your dashboard', ctaUrl: `${APP_URL}/#list-firm` });
  await sendMail({ to: e.clientEmail, subject: 'A firm has been selected for your request',
    bodyHtml: `<p>Good news: we have chosen a firm for ${job(e)}.</p><p>Log in to see why we chose them and to accept the introduction.</p>`,
    ctaLabel: 'Review the match', ctaUrl: `${APP_URL}/#client` });
}

async function clientAccepted(id) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  await sendMail({ to: firmEmails(firms), subject: 'The client accepted the introduction',
    bodyHtml: `<p>The client has accepted the introduction for ${job(e)}. Please log in and accept the engagement.</p>`, ctaLabel: 'Accept engagement', ctaUrl: `${APP_URL}/#list-firm` });
  await sendMail({ to: ADMIN_EMAIL, subject: `Client accepted: ${e.refCode}`, bodyHtml: `<p>${esc(e.clientName)} accepted the introduction for ${job(e)}. Set the fee if you have not yet.</p>`, ctaLabel: 'Open admin', ctaUrl: `${APP_URL}/#admin` });
}

async function firmAccepted(id) {
  const e = await getEng(id); if (!e) return;
  await sendMail({ to: e.clientEmail, subject: 'The firm accepted your engagement',
    bodyHtml: `<p>The firm has accepted ${job(e)}. ${e.feeAmount ? 'You can now pay to unlock their contact details.' : 'We will set the fee and let you know when you can pay.'}</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#client` });
  await sendMail({ to: ADMIN_EMAIL, subject: `Firm accepted: ${e.refCode}`, bodyHtml: `<p>The firm accepted ${job(e)}.</p>`, ctaLabel: 'Open admin', ctaUrl: `${APP_URL}/#admin` });
}

async function paid(id) {
  if (!once(`paid:${id}`)) return;
  const e = await getEng(id); if (!e) return;
  if (!['paid', 'released'].includes(String(e.paymentStatus || '').toLowerCase())) return;
  const firms = await firmsOf(e);
  await sendMail({ to: firmEmails(firms), subject: 'Payment received: client details unlocked',
    bodyHtml: `<p>The client has paid for ${job(e)}. Their contact details are now visible in your dashboard. You can start the work.</p>`, ctaLabel: 'Open your dashboard', ctaUrl: `${APP_URL}/#list-firm` });
  await sendMail({ to: e.clientEmail, subject: 'Payment received',
    bodyHtml: `<p>We received your payment for ${job(e)}. The firm's contact details are now unlocked in your portal.</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#client` });
  await sendMail({ to: ADMIN_EMAIL, subject: `Payment received: ${e.refCode}`, bodyHtml: `<p>${esc(e.clientName)} paid for ${job(e)}.</p>` });
}

async function delivered(id) {
  const e = await getEng(id); if (!e) return;
  await sendMail({ to: ADMIN_EMAIL, subject: `Work marked delivered: ${e.refCode}`, bodyHtml: `<p>The firm marked the work delivered for ${job(e)}. Please confirm completion.</p>`, ctaLabel: 'Open admin', ctaUrl: `${APP_URL}/#admin` });
  await sendMail({ to: e.clientEmail, subject: 'Your firm marked the work as delivered',
    bodyHtml: `<p>The firm has marked ${job(e)} as delivered. FinProMatch is confirming completion. If anything is wrong, message us in your portal now.</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#client` });
}

async function completed(id) {
  if (!once(`completed:${id}`)) return;
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  await sendMail({ to: e.clientEmail, subject: 'Your engagement is complete', bodyHtml: `<p>${job(e)} has been marked complete. Thank you for using FinProMatch.</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#client` });
  await sendMail({ to: firmEmails(firms), subject: 'Engagement marked complete', bodyHtml: `<p>${job(e)} has been confirmed complete by FinProMatch. Thank you.</p>`, ctaLabel: 'Open your dashboard', ctaUrl: `${APP_URL}/#list-firm` });
}

async function statusChanged(id) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  const label = String(e.status || '').toLowerCase().replace(/_/g, ' ');
  await sendMail({ to: [e.clientEmail, ...firmEmails(firms)], subject: `Engagement update: ${label}`, bodyHtml: `<p>The status of ${job(e)} is now <strong>${esc(label)}</strong>.</p>`, ctaLabel: 'Open FinProMatch', ctaUrl: APP_URL });
}

async function payoutReleased(id) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  await sendMail({ to: firmEmails(firms), subject: 'Your payout has been sent', bodyHtml: `<p>FinProMatch has recorded your payout as sent for ${job(e)}. Please check your bank account.</p>`, ctaLabel: 'Open your dashboard', ctaUrl: `${APP_URL}/#list-firm` });
}

async function withdrawn(id) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  await sendMail({ to: [ADMIN_EMAIL, ...firmEmails(firms)], subject: `Request withdrawn: ${e.refCode}`, bodyHtml: `<p>The client withdrew ${job(e)}.</p>` });
}

async function newMessage(id, senderRole) {
  const e = await getEng(id); if (!e) return;
  const firms = await firmsOf(e);
  let to = [];
  if (senderRole === 'client') to = [ADMIN_EMAIL, ...firmEmails(firms)];
  else if (senderRole === 'firm') to = [e.clientEmail, ADMIN_EMAIL];
  else to = [e.clientEmail, ...firmEmails(firms)]; // admin
  await sendMail({ to, subject: `New message on ${e.refCode}`, bodyHtml: `<p>There is a new message on ${job(e)}. Log in to read and reply.</p>`, ctaLabel: 'Open FinProMatch', ctaUrl: APP_URL });
}

/* ---- individual-professional (legacy lead) track ---- */
const getLead = (id) => prisma.lead.findUnique({ where: { id } });
async function leadCreated(id) {
  const l = await getLead(id); if (!l) return;
  await sendMail({ to: ADMIN_EMAIL, subject: `New client request: ${l.need}`, bodyHtml: `<p>${esc(l.name)} submitted a request (ref ${esc(l.refCode)}).</p>`, ctaLabel: 'Open admin', ctaUrl: `${APP_URL}/#admin` });
}
async function leadMatched(id) {
  const l = await getLead(id); if (!l) return;
  const ids = Array.isArray(l.matches) ? l.matches.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean) : [];
  const pros = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } } }) : [];
  await sendMail({ to: pros.map((p) => p.email), subject: 'New client request matched to you', bodyHtml: `<p>A client request (ref ${esc(l.refCode)}) has been matched to you. Log in to review it.</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#pro` });
}
async function leadDelivered(id) {
  const l = await getLead(id); if (!l) return;
  const client = await prisma.user.findUnique({ where: { id: l.clientId } });
  await sendMail({ to: [ADMIN_EMAIL, client && client.email], subject: `Work marked delivered: ${l.refCode}`, bodyHtml: `<p>The professional marked the work delivered for request ${esc(l.refCode)}.</p>` });
}
async function leadReleased(id) {
  const l = await getLead(id); if (!l || !l.chosenPro) return;
  const pro = await prisma.user.findUnique({ where: { id: l.chosenPro } });
  await sendMail({ to: pro && pro.email, subject: 'Your payout has been sent', bodyHtml: `<p>FinProMatch has recorded your payout as sent for request ${esc(l.refCode)}.</p>`, ctaLabel: 'Open your portal', ctaUrl: `${APP_URL}/#pro` });
}

module.exports = { newEngagement, matched, clientAccepted, firmAccepted, paid, delivered, completed, statusChanged, payoutReleased, withdrawn, newMessage, leadCreated, leadMatched, leadDelivered, leadReleased };