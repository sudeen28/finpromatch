const express = require('express');
const prisma = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/AppError');
const { presentEngagement } = require('../utils/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyClient } = require('../utils/notify');
const {
  engagementStatus: statusMap,
  STATUS_STAGE,
  toDbOrThrow,
} = require('../utils/enumMaps');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/engagements?stage=&sensitivity=&type=
// Mirrors the frontend admin dashboard's filter dropdowns (Phase 8).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { stage, sensitivity, type } = req.query;

    let engagements = await prisma.engagement.findMany({ orderBy: { createdAt: 'desc' } });
    let shaped = engagements.map(presentEngagement);

    if (stage) {
      shaped = shaped.filter((e) => STATUS_STAGE[e.status] === stage);
    }
    if (sensitivity) {
      shaped = shaped.filter((e) => e.sensitivity === sensitivity);
    }
    if (type) {
      shaped = shaped.filter((e) => e.engagementType === type);
    }

    res.json({ engagements: shaped });
  })
);

// PATCH /api/admin/engagements/:id/status — body: { status }
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    if (!req.body.status) throw new AppError(400, 'status is required.');
    const statusDb = toDbOrThrow(statusMap, req.body.status, 'status');

    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { status: statusDb },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

// PATCH /api/admin/engagements/:id/match — body: { firmIds: [...], reason: "..." }
// Mirrors the frontend's saveEngagementMatch: sets the manually-selected
// firms and reasoning, and auto-advances status out of "reviewing" — but
// never past that, and never based on any scoring. A human always chose
// firmIds and wrote reason. The match fee is set separately via PATCH
// .../fee once admin has decided on firms — matching and pricing are two
// different judgment calls and the UI treats them that way.
router.patch(
  '/:id/match',
  asyncHandler(async (req, res) => {
    const firmIds = Array.isArray(req.body.firmIds) ? req.body.firmIds : null;
    if (!firmIds || !firmIds.length) {
      throw new AppError(400, 'Select at least one firm.');
    }

    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');

    // Validate every firm id actually exists, so a typo doesn't silently
    // save a dangling reference.
    const firmCount = await prisma.firm.count({ where: { id: { in: firmIds } } });
    if (firmCount !== firmIds.length) {
      throw new AppError(400, 'One or more selected firms could not be found.');
    }

    const currentStatus = statusMap.fromDb[eng.status];
    const nextStatus =
      STATUS_STAGE[currentStatus] === 'reviewing' ? 'INTRODUCTION_SENT' : eng.status;

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: {
        selectedFirmIds: firmIds,
        matchReasonNote: req.body.reason ? String(req.body.reason).trim() : null,
        status: nextStatus,
      },
    });

    // Only the first time an engagement actually gets matched is worth
    // notifying the client about — re-saving firmIds/reason on an
    // already-matched engagement (a rematch, editing the note) shouldn't
    // re-fire the same notification.
    if (STATUS_STAGE[currentStatus] === 'reviewing') {
      await notifyClient(
        eng.clientId,
        'ENGAGEMENT_MATCHED',
        "You've been matched with a firm",
        `We've matched your request (${eng.refCode}) with a specialist firm. Review the introduction in your dashboard.`,
        eng.id
      );
    }

    res.json({ engagement: presentEngagement(updated) });
  })
);

// PATCH /api/admin/engagements/:id/fee — body: { feeAmount }
// Sets (or edits) the whole-naira match fee the client pays to unlock the
// matched firm's contact details. Editable any time before payment clears —
// once paymentStatus is PAID/RELEASED, changing it here wouldn't change
// what was actually charged, so it's blocked rather than silently lying
// about what the client paid.
router.patch(
  '/:id/fee',
  asyncHandler(async (req, res) => {
    const amount = Number(req.body.feeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError(400, 'feeAmount must be a positive number.');
    }

    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');
    if (eng.paymentStatus === 'PAID' || eng.paymentStatus === 'RELEASED') {
      throw new AppError(400, 'This engagement has already been paid for — the fee can no longer be changed.');
    }

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { feeAmount: Math.round(amount) },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

// POST /api/admin/engagements/:id/release-payment — admin confirms the work
// is done and releases the held match fee to the firm (minus commission),
// same shape as the individual-professional track's release step. This is
// bookkeeping, not an unlock: contact details are already visible once
// paymentStatus hits PAID — this just records that funds have moved on.
router.post(
  '/:id/release-payment',
  asyncHandler(async (req, res) => {
    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');
    if (eng.paymentStatus !== 'PAID') {
      throw new AppError(400, 'This engagement is not awaiting a payment release.');
    }

    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { paymentStatus: 'RELEASED' },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

module.exports = router;