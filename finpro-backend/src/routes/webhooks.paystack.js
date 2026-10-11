const express = require('express');
const prisma = require('../db');
const { verifyWebhookSignature } = require('../utils/paystack');

const router = express.Router();

/**
 * POST /api/webhooks/paystack — Paystack calls this server-to-server, not
 * through the browser. It needs the RAW request body to check the
 * signature, not the already-JSON-parsed one, so this route MUST be
 * mounted with express.raw({ type: 'application/json' }) and MUST be
 * registered before the app's global express.json() middleware runs —
 * see the index.js wiring note delivered alongside this file. If the
 * global json() parser sees this request first, the body stream is
 * already consumed by the time this handler runs and the signature check
 * always fails.
 *
 * This is a backstop, not the primary confirmation path: the client-facing
 * POST /api/engagements/:id/pay/verify call (run right after Paystack
 * redirects the browser back) is what the UI actually waits on. This
 * webhook exists to still mark the engagement paid if the person closes
 * the tab before that redirect completes.
 */
router.post('/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body; // a Buffer, thanks to express.raw() on this route
  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  // Ack immediately once the signature checks out — Paystack retries on any
  // non-2xx response, and there's nothing worth retrying for event types we
  // don't act on below.
  res.status(200).json({ received: true });

  if (event.event !== 'charge.success') return;

  const data = event.data || {};
  const reference = data.reference;
  const engagementId = data.metadata && data.metadata.engagementId;
  if (!reference) return;

  try {
    const eng = engagementId
      ? await prisma.engagement.findUnique({ where: { id: engagementId } })
      : await prisma.engagement.findFirst({ where: { paystackRef: reference } });
    if (!eng || eng.paymentStatus === 'PAID' || eng.paymentStatus === 'RELEASED') return; // not ours, or already handled

    // Belt-and-braces: don't trust the webhook's amount blindly, confirm it
    // matches what we actually charged this engagement for.
    const expectedKobo = eng.feeAmount ? Math.round(eng.feeAmount * 100) : null;
    if (expectedKobo !== null && data.amount !== expectedKobo) return;

    await prisma.engagement.update({
      where: { id: eng.id },
      data: { paymentStatus: 'PAID', paidAt: new Date(), paystackRef: reference },
    });
  } catch (err) {
    console.error('Paystack webhook handling failed:', err.message);
  }
});

module.exports = router;