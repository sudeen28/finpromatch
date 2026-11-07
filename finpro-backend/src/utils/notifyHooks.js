/**
 * Sends notification emails after successful API calls, WITHOUT editing the
 * existing route files. Mount once, before the routers:
 *     app.use('/api', require('./middleware/notifyHooks'));
 *
 * It watches method + path of finished, successful (<400) requests and fires
 * the matching function from utils/notifications.js in the background.
 */
const n = require('../utils/notifications');

const RULES = [
  // [method, regex on path after /api, handler(match, payload) -> Promise]
  ['POST',  /^\/engagements\/?$/,                         (m, p) => p && p.engagement && n.newEngagement(p.engagement.id)],
  ['PATCH', /^\/admin\/engagements\/([^/]+)\/match$/,     (m) => n.matched(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/accept$/,           (m) => n.clientAccepted(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/firm-accept$/,      (m) => n.firmAccepted(m[1])],
  ['GET',   /^\/engagements\/([^/]+)\/pay\/verify$/,      (m) => n.paid(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/pay\/verify$/,      (m) => n.paid(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/deliver$/,          (m) => n.delivered(m[1])],
  ['POST',  /^\/admin\/engagements\/([^/]+)\/complete$/,  (m) => n.completed(m[1])],
  ['PATCH', /^\/admin\/engagements\/([^/]+)\/status$/,    (m) => n.statusChanged(m[1])],
  ['POST',  /^\/admin\/engagements\/([^/]+)\/release-payment$/, (m) => n.payoutReleased(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/withdraw$/,         (m) => n.withdrawn(m[1])],
  ['POST',  /^\/engagements\/([^/]+)\/messages$/,         (m, p) => n.newMessage(m[1], p && p.message && p.message.senderRole)],
  // individual-professional (lead) track
  ['POST',  /^\/leads\/?$/,                               (m, p) => p && p.lead && n.leadCreated(p.lead.id)],
  ['POST',  /^\/admin\/leads\/([^/]+)\/confirm-match$/,   (m) => n.leadMatched(m[1])],
  ['POST',  /^\/leads\/([^/]+)\/deliver$/,                (m) => n.leadDelivered(m[1])],
  ['POST',  /^\/admin\/leads\/([^/]+)\/release-payment$/, (m) => n.leadReleased(m[1])],
];

module.exports = function notifyHooks(req, res, next) {
  let payload;
  const origJson = res.json.bind(res);
  res.json = (body) => { payload = body; return origJson(body); };

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const path = req.originalUrl.split('?')[0].replace(/^\/api/, '');
    for (const [method, re, handler] of RULES) {
      if (req.method !== method) continue;
      const m = path.match(re);
      if (!m) continue;
      Promise.resolve()
        .then(() => handler(m, payload))
        .catch((err) => console.error('[notify]', err.message));
      break;
    }
  });
  next();
};