/** Returns a copy of a User/Firm/Admin record with passwordHash removed. */
function publicAccount(record) {
  if (!record) return record;
  const { passwordHash, ...safe } = record;
  return safe;
}

const { sensitivity, capacity, availability, verificationStatus, engagementStatus, messageSenderRole, leadStatus, notificationType, paymentStatus } = require('./enumMaps');

/**
 * Reshapes a Firm DB record into the flatter/nested shape the frontend
 * prototype already works with — credentials as a nested object,
 * verification levels as a nested object, enum fields back to lowercase ids.
 */
function presentFirm(firm) {
  if (!firm) return firm;
  const safe = publicAccount(firm);
  return {
    ...safe,
    capacity: capacity.fromDb[safe.capacity],
    availability: availability.fromDb[safe.availability],
    verificationStatus: verificationStatus.fromDb[safe.verificationStatus],
    credentials: {
      ican: safe.credentialIcan,
      anan: safe.credentialAnan,
      citn: safe.credentialCitn,
      other: safe.credentialOther,
      verificationDocs: safe.verificationDocs,
    },
    verificationLevels: {
      identity: safe.verifyIdentity,
      credentials: safe.verifyCredentials,
      firm: safe.verifyFirm,
    },
  };
}

/** Reshapes an Engagement DB record, converting enum fields back to lowercase ids. */
function presentEngagement(eng) {
  if (!eng) return eng;
  return {
    ...eng,
    sensitivity: sensitivity.fromDb[eng.sensitivity],
    status: engagementStatus.fromDb[eng.status],
    paymentStatus: paymentStatus.fromDb[eng.paymentStatus],
  };
}

/** Reshapes a Message DB record, converting the sender-role enum back to a lowercase id. */
function presentMessage(msg) {
  if (!msg) return msg;
  return {
    ...msg,
    senderRole: messageSenderRole.fromDb[msg.senderRole],
  };
}

/** Reshapes a Lead DB record, converting the status enum back to a lowercase id. */
function presentLead(lead) {
  if (!lead) return lead;
  return {
    ...lead,
    status: leadStatus.fromDb[lead.status],
  };
}

/**
 * Reshapes a Notification DB record: converts the type enum back to a
 * lowercase id, and collapses the three optional recipient*Id columns into
 * a single { role, id } pair — a caller only ever needs to know it belongs
 * to *their* account (already enforced by the query), not which column.
 */
function presentNotification(n) {
  if (!n) return n;
  const { recipientUserId, recipientFirmId, recipientAdminId, ...rest } = n;
  let recipient = null;
  if (recipientUserId) recipient = { role: 'client', id: recipientUserId };
  else if (recipientFirmId) recipient = { role: 'firm', id: recipientFirmId };
  else if (recipientAdminId) recipient = { role: 'admin', id: recipientAdminId };
  return {
    ...rest,
    type: notificationType.fromDb[n.type],
    recipient,
  };
}

module.exports = { publicAccount, presentFirm, presentEngagement, presentMessage, presentLead, presentNotification };