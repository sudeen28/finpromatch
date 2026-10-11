const { AppError } = require('./AppError');

/**
 * The frontend prototype uses lowercase_snake_case string ids everywhere
 * (e.g. 'client_accepted', 'high', 'small'). Prisma enums are UPPER_SNAKE.
 * These maps translate at the API boundary so frontend code barely has to
 * change when it's switched from window.storage to this API later.
 */
function buildMap(ids) {
  const toDb = {};
  const fromDb = {};
  ids.forEach((id) => {
    const db = id.toUpperCase();
    toDb[id] = db;
    fromDb[db] = id;
  });
  return { toDb, fromDb };
}

const sensitivity = buildMap(['standard', 'confidential', 'high', 'highly_sensitive']);
const capacity = buildMap(['small', 'medium', 'large', 'enterprise']);
const availability = buildMap(['accepting', 'limited', 'fully_booked']);
const verificationStatus = buildMap(['pending', 'verified', 'info_required', 'rejected']);
const messageSenderRole = buildMap(['client', 'firm', 'admin']);
const leadStatus = buildMap(['pending', 'matched', 'engaged', 'paid', 'delivered', 'released']);
const notificationType = buildMap(['engagement_matched', 'firm_verified', 'firm_info_required', 'firm_rejected', 'message_received']);
const paymentStatus = buildMap(['unpaid', 'pending', 'paid', 'released', 'failed']);

const engagementStatus = buildMap([
  'new',
  'under_review',
  'matching',
  'firm_selected',
  'introduction_sent',
  'client_accepted',
  'firm_accepted',
  'active',
  'completed',
  'declined',
  'rematch',
  'closed',
]);

/** Mirrors the frontend's ENGAGEMENT_STATUSES stage grouping, for admin filters. */
const STATUS_STAGE = {
  new: 'reviewing',
  under_review: 'reviewing',
  matching: 'reviewing',
  rematch: 'reviewing',
  firm_selected: 'matched',
  introduction_sent: 'matched',
  client_accepted: 'matched',
  firm_accepted: 'matched',
  active: 'matched',
  completed: 'completed',
  declined: 'closed',
  closed: 'closed',
};

/** Statuses where a firm's contact details (and message thread) become visible to the client, and vice versa. */
const CONTACT_VISIBLE_STATUSES = ['client_accepted', 'firm_accepted', 'active', 'completed'];

function toDbOrThrow(map, value, label) {
  const db = map.toDb[value];
  if (!db) {
    throw new AppError(400, `Invalid ${label}: "${value}". Allowed: ${Object.keys(map.toDb).join(', ')}`);
  }
  return db;
}

module.exports = {
  sensitivity,
  capacity,
  availability,
  verificationStatus,
  messageSenderRole,
  leadStatus,
  notificationType,
  paymentStatus,
  engagementStatus,
  STATUS_STAGE,
  CONTACT_VISIBLE_STATUSES,
  toDbOrThrow,
};