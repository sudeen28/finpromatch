/**
 * Completion flow:
 *   1. Firm clicks "Mark work delivered"        POST /api/engagements/:id/deliver
 *   2. Admin confirms completion                 POST /api/admin/engagements/:id/complete
 *   3. Admin records the payout (existing route) POST /api/admin/engagements/:id/release-payment
 *
 * Mount:  app.use('/api', require('./routes/engagementWork'));
 */
const express = require('express');
const prisma = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/AppError');
const { presentEngagement } = require('../utils/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.post(
  '/engagements/:id/deliver',
  requireAuth,
  requireRole('firm'),
  asyncHandler(async (req, res) => {
    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');
    if (!eng.selectedFirmIds.includes(req.auth.id)) throw new AppError(403, 'This engagement was not matched to your firm.');
    if (!['PAID', 'RELEASED'].includes(String(eng.paymentStatus || '').toUpperCase())) {
      throw new AppError(400, 'The client has not paid yet, so work cannot be marked delivered.');
    }
    if (['COMPLETED', 'CLOSED', 'DECLINED'].includes(eng.status)) throw new AppError(400, 'This engagement is already closed.');
    if (eng.deliveredAt) throw new AppError(400, 'Already marked as delivered.');
    const updated = await prisma.engagement.update({
      where: { id: eng.id },
      data: { deliveredAt: new Date(), status: eng.status === 'FIRM_ACCEPTED' || eng.status === 'CLIENT_ACCEPTED' ? 'ACTIVE' : eng.status },
    });
    res.json({ engagement: presentEngagement(updated) });
  })
);

router.post(
  '/admin/engagements/:id/complete',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const eng = await prisma.engagement.findUnique({ where: { id: req.params.id } });
    if (!eng) throw new AppError(404, 'Engagement not found.');
    if (eng.status === 'COMPLETED') throw new AppError(400, 'Already completed.');
    const updated = await prisma.engagement.update({ where: { id: eng.id }, data: { status: 'COMPLETED' } });
    res.json({ engagement: presentEngagement(updated) });
  })
);

module.exports = router;