/**
 * Admin account management — list clients and delete demo/test accounts.
 * Mount:  app.use('/api/admin', require('./routes/adminAccounts'));
 *
 * Deleting is permanent. A client delete also removes that client's
 * engagements, messages and requests. A firm/professional delete removes
 * them from matches but keeps clients' engagement history.
 */
const express = require('express');
const prisma = require('../db');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/AppError');
const { publicAccount } = require('../utils/serialize');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get(
  '/clients',
  asyncHandler(async (req, res) => {
    const clients = await prisma.user.findMany({ where: { role: 'CLIENT' }, orderBy: { createdAt: 'desc' } });
    const counts = await prisma.engagement.groupBy({ by: ['clientId'], _count: { _all: true } });
    const byId = Object.fromEntries(counts.map((c) => [c.clientId, c._count._all]));
    res.json({ clients: clients.map((c) => ({ ...publicAccount(c), engagementCount: byId[c.id] || 0 })) });
  })
);

router.delete(
  '/clients/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user || user.role !== 'CLIENT') throw new AppError(404, 'Client account not found.');
    await prisma.$transaction(async (tx) => {
      const engs = await tx.engagement.findMany({ where: { clientId: user.id }, select: { id: true } });
      const ids = engs.map((e) => e.id);
      await tx.message.deleteMany({ where: { OR: [{ engagementId: { in: ids } }, { senderUserId: user.id }] } });
      await tx.engagement.deleteMany({ where: { clientId: user.id } });
      await tx.lead.deleteMany({ where: { clientId: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });
    res.json({ ok: true });
  })
);

router.delete(
  '/firms/:id',
  asyncHandler(async (req, res) => {
    const firm = await prisma.firm.findUnique({ where: { id: req.params.id } });
    if (!firm) throw new AppError(404, 'Firm not found.');
    await prisma.$transaction(async (tx) => {
      const matched = await tx.engagement.findMany({ where: { selectedFirmIds: { has: firm.id } } });
      for (const e of matched) {
        await tx.engagement.update({ where: { id: e.id }, data: { selectedFirmIds: e.selectedFirmIds.filter((x) => x !== firm.id) } });
      }
      await tx.engagement.updateMany({ where: { interestedFirmId: firm.id }, data: { interestedFirmId: null } });
      await tx.lead.updateMany({ where: { interestedFirmId: firm.id }, data: { interestedFirmId: null } });
      await tx.message.updateMany({ where: { senderFirmId: firm.id }, data: { senderFirmId: null } });
      await tx.firm.delete({ where: { id: firm.id } });
    });
    res.json({ ok: true });
  })
);

router.delete(
  '/professionals/:id',
  asyncHandler(async (req, res) => {
    const pro = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!pro || pro.role !== 'PROFESSIONAL') throw new AppError(404, 'Professional account not found.');
    await prisma.$transaction(async (tx) => {
      await tx.message.updateMany({ where: { senderUserId: pro.id }, data: { senderUserId: null } });
      await tx.lead.updateMany({ where: { chosenPro: pro.id }, data: { chosenPro: null } });
      const leads = await tx.lead.findMany({ where: { matches: { has: pro.id } } });
      for (const l of leads) {
        await tx.lead.update({ where: { id: l.id }, data: { matches: l.matches.filter((x) => x !== pro.id) } });
      }
      await tx.user.delete({ where: { id: pro.id } });
    });
    res.json({ ok: true });
  })
);

module.exports = router;