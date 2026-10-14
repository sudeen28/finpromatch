const { AppError } = require('./AppError');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * Starts a Paystack transaction and returns the hosted checkout URL to send
 * the client to. Amount is accepted here in whole Naira and converted to
 * kobo (Paystack's smallest unit) at the last moment, so every caller
 * elsewhere in the codebase keeps working in the same whole-naira numbers
 * that feeAmount already uses everywhere else (Lead.feeAmount,
 * Engagement.feeAmount).
 */
async function initializeTransaction({ email, amountNaira, reference, callbackUrl, metadata }) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new AppError(500, 'Payments are not configured on the server (missing PAYSTACK_SECRET_KEY).');
  }
  let resp;
  try {
    resp = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amountNaira * 100),
        currency: 'NGN',
        reference,
        callback_url: callbackUrl,
        metadata,
      }),
    });
  } catch (err) {
    throw new AppError(502, `Could not reach Paystack: ${err.message}`);
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.status) {
    throw new AppError(502, (data && data.message) || 'Paystack could not start this payment.');
  }
  return data.data; // { authorization_url, access_code, reference }
}

/**
 * Confirms a transaction's final status directly with Paystack — this is
 * the source of truth; a client-supplied "I paid" claim is never trusted on
 * its own, only used to tell us which reference to go check.
 */
async function verifyTransaction(reference) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new AppError(500, 'Payments are not configured on the server (missing PAYSTACK_SECRET_KEY).');
  }
  let resp;
  try {
    resp = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
  } catch (err) {
    throw new AppError(502, `Could not reach Paystack: ${err.message}`);
  }
  const data = await resp.json().catch(() => null);
  if (!data || !data.status) {
    throw new AppError(502, (data && data.message) || 'Paystack could not verify this payment.');
  }
  return data.data; // { status: 'success' | 'failed' | 'abandoned', amount, reference, ... }
}

/**
 * Checks that an incoming webhook POST actually came from Paystack, by
 * recomputing the HMAC-SHA512 signature over the raw request body with our
 * secret key and comparing it to the x-paystack-signature header. Must run
 * against the raw, unparsed body — see routes/webhooks.paystack.js and the
 * index.js wiring note that ships alongside it.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!PAYSTACK_SECRET_KEY || !signatureHeader || !rawBody) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  return expected === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };