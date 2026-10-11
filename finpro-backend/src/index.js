require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { attachAuth } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const clientAuthRoutes = require('./routes/auth.client');
const proAuthRoutes = require('./routes/auth.pro');
const firmAuthRoutes = require('./routes/auth.firm');
const adminAuthRoutes = require('./routes/auth.admin');


const { router: engagementsRoutes } = require('./routes/engagements');
const firmsRoutes = require('./routes/firms');
const messagesRoutes = require('./routes/messages');
const adminEngagementsRoutes = require('./routes/admin.engagements');
const adminFirmsRoutes = require('./routes/admin.firms');
const adminRoutes = require('./routes/admin');
const webhooksPaystackRoutes = require('./routes/webhooks.paystack');

const { router: leadsRoutes } = require('./routes/leads');
const leadsProfessionalRoutes = require('./routes/leads.professional');
const adminLeadsRoutes = require('./routes/admin.leads');

const app = express();

// --- core middleware ---
const allowedOrigins = (process.env.CORS_ORIGINS || '')
.split(',')
.map((s) => s.trim())
.filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true, // reflect request origin if none configured (dev-friendly default)
    credentials: true,
  })
);

// Paystack webhooks MUST be mounted before express.json() below, with the
// raw (unparsed) body — the signature check needs the exact bytes Paystack
// sent, and once express.json() has consumed the request stream for any
// path, this route can never get the raw bytes back.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksPaystackRoutes);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachAuth); // decodes a bearer token into req.auth on every request, if present
app.use('/api/guest-briefs', require('./routes/guestBriefs'))
app.use('/api/admin/guest-briefs', require('./routes/admin.guestBriefs'))

// --- health check (useful for Render's health checks / uptime monitors) ---
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'taxbridge-backend', time: new Date().toISOString() });
});

// --- routes ---
// Auth is split by account type because they're genuinely separate tables
// (User for client/professional, Firm, Admin) with different signup fields.
app.use('/api/auth/client', clientAuthRoutes);
app.use('/api/auth/professional', proAuthRoutes);
app.use('/api/auth/firm', firmAuthRoutes);
app.use('/api/auth/admin', adminAuthRoutes);

// Resource routes (Phase B2)
// Two routers share the '/api/engagements' base path — Express supports
// this fine, they're just registered one after another.
app.use('/api/engagements', engagementsRoutes);
app.use('/api/engagements', messagesRoutes);
app.use('/api/firms', firmsRoutes);
app.use('/api/admin/engagements', adminEngagementsRoutes);
app.use('/api/admin/firms', adminFirmsRoutes);
app.use('/api/admin', adminRoutes);

// leads.professional must be mounted BEFORE leads (client) — its
// '/matched-to-me' path would otherwise be swallowed by leads.js's
// '/:id' pattern (same class of bug as the engagements '/matched-to-me' fix).
app.use('/api/leads', leadsProfessionalRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/admin/leads', adminLeadsRoutes);

app.use('/api/notifications', require('./routes/notifications'));

// Frontend is still on window.storage — switching it onto this API is the next phase.

// --- 404 for anything unmatched under /api ---
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// --- central error handler (must be registered last) ---
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TaxBridge backend listening on port ${PORT}`);
});

module.exports = app;