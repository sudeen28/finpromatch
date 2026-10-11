const express = require('express');
const prisma = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/AppError');
const { requireFields } = require('../utils/validate');
const { generateUniqueRefCode } = require('../utils/refCode');
const { presentEngagement } = require('../utils/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');
const { initializeTransaction, verifyTransaction } = require('../utils/paystack');
const {
  sensitivity: sensitivityMap,
  engagementStatus: statusMap,
  toDbOrThrow,
  CONTACT_VISIBLE_STATUSES,
  STATUS_STAGE,
} = require('../utils/enumMaps');

const router = express.Router();

/** Loads an engagement or 404s. */
async function loadEngagementOr404(id) {
  const eng = await prisma.engagement.findUnique({ where: { id } });
  if (!eng) throw new AppError(404, 'Engagement not found.');
  return eng;
}

/**
 * Authorization check shared by the single-engagement GET and the messages
 * routes: who is allowed to see this engagement (and message in its thread)
 * at all.
 * - The owning client: always.
 * - Admin: always.
 * - A firm in selectedFirmIds: only once the client has accepted the
 *   introduction (matches the frontend's existing staged privacy reveal —
 *   a firm doesn't get visibility into a request it hasn't been introduced
 *   on yet).
 *
 * This is deliberately separate from whether raw contact details (email/
 * phone) are shown — that's gated on payment, see contactDetailsUnlocked()
 * below. A firm and client can see the thread and talk once accepted, even
 * before the match fee is paid; only the actual email/phone stay hidden
 * until then.
 */
function canViewEngagement(eng, auth) {
  if (!auth) return false;
  if (auth.role === 'admin') return true;
  if (auth.role === 'client') return eng.clientId === auth.id;
  if (auth.role === 'firm') {
    return eng.selectedFirmIds.includes(auth.id) && CONTACT_VISIBLE_STATUSES.includes(statusMap.fromDb[eng.status]);
  }
  return false;
}

/** Whether the match-fee payment has cleared — the single gate on raw contact-detail visibility. */
function contactDetailsUnlocked(eng) {
  return eng.paymentStatus === 'PAID' || eng.paymentStatus === 'RELEASED';
}

// POST /api/engagements — client submits a new engagement request
router.post(
  '/',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    requireFields(req.body, ['industry', 'businessSize', 'engagementType', 'details']);

    const client = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!client) throw new AppError(404, 'Account not found.');

    const sensitivityDb = req.body.sensitivity
      ? toDbOrThrow(sensitivityMap, req.body.sensitivity, 'sensitivity')
      : 'STANDARD';

    const refCode = await generateUniqueRefCode(prisma.engagement, 'FPM');

    const eng = await prisma.engagement.create({
      data: {
        refCode,
        clientId: client.id,
        // Snapshot the client's contact details at submission time — taken
        // from the authenticated account, never trusted from the request body.
        clientName: client.name,
        clientEmail: client.email,
        clientPhone: client.phone,

        company: req.body.company ? String(req.body.company).trim() : null,
        industry: String(req.body.industry).trim(),
        businessSize: String(req.body.businessSize).trim(),

        engagementType: String(req.body.engagementType).trim(),
        typeAnswers: Array.isArray(req.body.typeAnswers) ? req.body.typeAnswers : undefined,

        details: String(req.body.details).trim(),

        deadline: req.body.deadline ? new Date(req.body.deadline) : null,
        estimatedValue: req.body.estimatedValue ? String(req.body.estimatedValue).trim() : null,
        expectedDuration: req.body.expectedDuration ? String(req.body.expectedDuration).trim() : null,

        country: req.body.country ? String(req.body.country).trim() : null,
        state: req.body.state ? String(req.body.state).trim() : null,
        city: req.body.city ? String(req.body.city).trim() : null,
        onSiteRequired: Boolean(req.body.onSiteRequired),

        sensitivity: sensitivityDb,
        status: 'NEW',

        interestedFirmId: req.body.interestedFirmId ? String(req.body.interestedFirmId) : null,
      },
    });

    res.status(201).json({ engagement: presentEngagement(eng) });
  })
);

const EDITABLE_STAGE = 'reviewing'; // new / under_review / matching / rematch — before any firm has been selected
const TERMINAL_STATUSES = ['completed', 'declined', 'closed'];

/**
 * PATCH /api/engagements/:id — client edits their own request, but only
 * before any firm has been selected. Once matching has started, changing
 * the brief out from under the admin/firm would be confusing, so this is
 * deliberately locked once the engagement leaves the 'reviewing' stage.
 */
router.patch(
  '/:id',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) throw new AppError(403, 'Not your request.');
    if (STATUS_STAGE[statusMap.fromDb[eng.status]] !== EDITABLE_STAGE) {
      throw new AppError(400, 'This request is already being reviewed and can no longer be edited — reach out to our team instead.');
    }
    requireFields(req.body, ['industry', 'businessSize', 'engagementType', 'details']);

    const sensitivityDb = req.body.sensitivity
      ? toDbOrThrow(sensitivityMap, req.body.sensitivity, 'sensitivity')
      : eng.sensitivity;

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: {
        company: req.body.company ? String(req.body.company).trim() : null,
        industry: String(req.body.industry).trim(),
        businessSize: String(req.body.businessSize).trim(),
        engagementType: String(req.body.engagementType).trim(),
        typeAnswers: Array.isArray(req.body.typeAnswers) ? req.body.typeAnswers : undefined,
        details: String(req.body.details).trim(),
        deadline: req.body.deadline ? new Date(req.body.deadline) : null,
        estimatedValue: req.body.estimatedValue ? String(req.body.estimatedValue).trim() : null,
        expectedDuration: req.body.expectedDuration ? String(req.body.expectedDuration).trim() : null,
        country: req.body.country ? String(req.body.country).trim() : null,
        state: req.body.state ? String(req.body.state).trim() : null,
        city: req.body.city ? String(req.body.city).trim() : null,
        onSiteRequired: Boolean(req.body.onSiteRequired),
        sensitivity: sensitivityDb,
      },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

/**
 * POST /api/engagements/:id/withdraw — client withdraws their own request.
 * This is a soft-close (status -> closed), not a hard delete: admin should
 * still be able to see withdrawn requests for their own records.
 */
router.post(
  '/:id/withdraw',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) throw new AppError(403, 'Not your request.');
    if (TERMINAL_STATUSES.includes(statusMap.fromDb[eng.status])) {
      throw new AppError(400, 'This request is already closed.');
    }
    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { status: 'CLOSED' },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

/**
 * DELETE /api/engagements/:id — client permanently removes a request from
 * their own history. Unlike /withdraw (a soft-close that admin can still
 * see and act on), this hard-deletes the row — so it's only allowed once
 * the request has reached a terminal status (completed/declined/closed).
 * An active request (reviewing/matched/etc.) must be withdrawn first;
 * deleting something admin or a firm might still be acting on would pull
 * the rug out from under them, and cascading message history away mid-flow
 * would be a real loss, not just tidying up.
 * Prisma's Message.engagement relation cascades on delete, so the thread
 * for this engagement is removed automatically.
 */
router.delete(
  '/:id',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) throw new AppError(403, 'Not your request.');
    if (!TERMINAL_STATUSES.includes(statusMap.fromDb[eng.status])) {
      throw new AppError(400, 'Only completed, declined, or closed requests can be deleted — withdraw it first.');
    }
    await prisma.engagement.delete({ where: { id: eng.id } });
    res.json({ success: true });
  })
);

// GET /api/engagements/mine — client's own engagement requests
router.get(
  '/mine',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const engagements = await prisma.engagement.findMany({
      where: { clientId: req.auth.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ engagements: engagements.map(presentEngagement) });
  })
);

// GET /api/engagements/matched-to-me — firm's own matched engagements (firmDashEngagementsHtml equivalent)
// Registered BEFORE /:id so Express doesn't swallow this path as an :id param.
router.get(
  '/matched-to-me',
  requireAuth,
  requireRole('firm'),
  asyncHandler(async (req, res) => {
    const engagements = await prisma.engagement.findMany({
      where: { selectedFirmIds: { has: req.auth.id } },
      orderBy: { createdAt: 'desc' },
    });
    // The client's raw contact details are only meaningful to include once
    // the match fee has cleared — strip them out server-side rather than
    // trusting the frontend to hide them.
    const shaped = engagements.map((eng) => {
      const presented = presentEngagement(eng);
      const contactVisible = contactDetailsUnlocked(eng);
      if (!contactVisible) {
        presented.clientEmail = null;
        presented.clientPhone = null;
      }
      return { ...presented, contactVisible };
    });
    res.json({ engagements: shaped });
  })
);

// GET /api/engagements/:id — single engagement, visible to its client, admin, or a matched+accepted firm
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (!canViewEngagement(eng, req.auth)) {
      throw new AppError(403, 'You do not have access to this engagement.');
    }
    const presented = presentEngagement(eng);

    // Once the client's match fee has cleared, attach the matched firm's
    // contact details — this is the only place a client sees a firm's
    // direct email/phone for this engagement, deliberately withheld until
    // payment clears (see contactDetailsUnlocked()).
    if (req.auth.role === 'client' && contactDetailsUnlocked(eng) && eng.selectedFirmIds.length) {
      const firm = await prisma.firm.findUnique({ where: { id: eng.selectedFirmIds[0] } });
      if (firm) {
        presented.firmContact = { id: firm.id, firmName: firm.firmName, email: firm.email, phone: firm.phone };
      }
    }

    res.json({ engagement: presented });
  })
);

// POST /api/engagements/:id/accept — client accepts the introduction to a matched firm.
// body: { firmId } — required when more than one firm was offered, so the
// client explicitly picks one. That firm is the only one who keeps contact
// visibility and thread access going forward; any other candidates offered
// alongside it are dropped from selectedFirmIds at this point, since both
// of those permissions are gated purely on membership in that array.
router.post(
  '/:id/accept',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) {
      throw new AppError(403, 'You do not have access to this engagement.');
    }
    const currentStatus = statusMap.fromDb[eng.status];
    const acceptableFrom = ['firm_selected', 'introduction_sent'];
    if (!acceptableFrom.includes(currentStatus)) {
      throw new AppError(400, 'This engagement is not awaiting your acceptance.');
    }

    let chosenFirmId = req.body.firmId ? String(req.body.firmId) : null;
    if (eng.selectedFirmIds.length > 1) {
      if (!chosenFirmId) {
        throw new AppError(400, "Select which firm you'd like to work with.");
      }
      if (!eng.selectedFirmIds.includes(chosenFirmId)) {
        throw new AppError(400, 'That firm was not offered for this engagement.');
      }
    } else if (eng.selectedFirmIds.length === 1) {
      chosenFirmId = eng.selectedFirmIds[0];
    } else {
      throw new AppError(400, 'No firm has been offered for this engagement yet.');
    }

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { status: 'CLIENT_ACCEPTED', selectedFirmIds: [chosenFirmId] },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

// POST /api/engagements/:id/firm-accept — firm accepts an engagement the client has already accepted
router.post(
  '/:id/firm-accept',
  requireAuth,
  requireRole('firm'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (!eng.selectedFirmIds.includes(req.auth.id)) {
      throw new AppError(403, 'This engagement was not matched to your firm.');
    }
    const currentStatus = statusMap.fromDb[eng.status];
    if (currentStatus !== 'client_accepted') {
      throw new AppError(400, 'This engagement is not awaiting your acceptance.');
    }
    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { status: 'FIRM_ACCEPTED' },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

// POST /api/engagements/:id/pay/init — client starts paying the match fee
// for the firm they just accepted. Returns a Paystack hosted-checkout URL
// to redirect the browser to; nothing is marked paid here, only PENDING —
// only pay/verify (or the webhook) ever sets PAID.
router.post(
  '/:id/pay/init',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) {
      throw new AppError(403, 'You do not have access to this engagement.');
    }
    const currentStatus = statusMap.fromDb[eng.status];
    if (!['client_accepted', 'firm_accepted', 'active', 'completed'].includes(currentStatus)) {
      throw new AppError(400, 'Accept a firm introduction before paying.');
    }
    if (!eng.feeAmount) {
      throw new AppError(400, 'A fee has not been set for this engagement yet — contact our team.');
    }
    if (eng.paymentStatus === 'PAID' || eng.paymentStatus === 'RELEASED') {
      throw new AppError(400, 'This engagement has already been paid for.');
    }

    const reference = `FPM-PAY-${eng.refCode}-${Date.now()}`;
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const callbackUrl = `${frontendUrl}/?payment_callback=1&engagement=${eng.id}`;

    const tx = await initializeTransaction({
      email: eng.clientEmail,
      amountNaira: eng.feeAmount,
      reference,
      callbackUrl,
      metadata: { engagementId: eng.id, refCode: eng.refCode },
    });

    await prisma.engagement.update({
      where: { id: eng.id },
      data: { paystackRef: reference, paymentStatus: 'PENDING' },
    });

    res.json({ authorizationUrl: tx.authorization_url, reference });
  })
);

// GET /api/engagements/:id/pay/verify — confirms the engagement's current
// Paystack reference (set by pay/init) directly with Paystack and, if
// successful, unlocks contact details. No reference is taken from the
// request — we only ever verify the one we ourselves generated and stored,
// never a client-supplied string. Idempotent: calling it again on an
// already-paid engagement just returns the current state.
router.get(
  '/:id/pay/verify',
  requireAuth,
  requireRole('client'),
  asyncHandler(async (req, res) => {
    const eng = await loadEngagementOr404(req.params.id);
    if (eng.clientId !== req.auth.id) {
      throw new AppError(403, 'You do not have access to this engagement.');
    }

    if (eng.paymentStatus === 'PAID' || eng.paymentStatus === 'RELEASED') {
      return res.json({ engagement: presentEngagement(eng), alreadyPaid: true });
    }
    if (!eng.paystackRef) {
      throw new AppError(400, 'No payment has been started for this engagement yet.');
    }

    const tx = await verifyTransaction(eng.paystackRef);
    if (tx.status !== 'success') {
      await prisma.engagement.update({ where: { id: eng.id }, data: { paymentStatus: 'FAILED' } });
      throw new AppError(400, `Payment was not successful (status: ${tx.status}).`);
    }

    const expectedKobo = Math.round(eng.feeAmount * 100);
    if (tx.amount !== expectedKobo) {
      throw new AppError(400, 'Payment amount does not match the expected fee.');
    }

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { paymentStatus: 'PAID', paidAt: new Date() },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

module.exports = { router, loadEngagementOr404, canViewEngagement, contactDetailsUnlocked };