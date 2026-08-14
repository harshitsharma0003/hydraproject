'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const rid = require('./requestid');

const app = express();

// Safety net: a single failed request (an unhandled promise rejection, e.g. a
// rate-limited embedding call in the query path) must never take the whole
// gateway down. Log and keep serving - the invariant is that a gateway problem
// degrades one request to native search, it does not become a storefront outage.
process.on('unhandledRejection', (err) => {
  rid.error('unhandledRejection', { err: err && err.message, stack: err && err.stack });
});
process.on('uncaughtException', (err) => {
  rid.error('uncaughtException', { err: err && err.message, stack: err && err.stack });
});

app.use(helmet());
// First, so every log line and every response downstream carries the id.
app.use(rid.middleware);
// Stripe verifies the webhook signature against the EXACT raw bytes, so JSON
// parsing must not consume the body first. Every other route gets normal JSON
// parsing; the webhook route (mounted at /v1/billing/webhook) applies its own
// express.raw() and reads req.body as a Buffer.
app.use((req, res, next) => {
  if (req.originalUrl === '/v1/billing/webhook') return next();
  express.json({ limit: '8mb' })(req, res, next);   // sync batches
});
app.use(cors({
  origin: (origin, cb) => cb(null, true),  // per-key origin lock happens in auth
  credentials: false
}));

app.get('/health', (req, res) =>
  res.json({ ok: true, version: '1.0.0', requestId: req.requestId }));

// Contract is versioned so a gateway deploy cannot break a cartridge in the field.
app.use('/v1', require('./routes/query'));
app.use('/v1', require('./routes/refine'));
app.use('/v1', require('./routes/narrate'));
app.use('/v1', require('./routes/sync'));
app.use('/v1', require('./routes/discover'));
app.use('/v1', require('./routes/event'));
app.use('/v1', require('./routes/health'));
app.use('/v1', require('./routes/bulk'));
app.use('/v1', require('./routes/provision').router);
app.use('/api', require('./routes/reset'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/portal').router);
app.use('/api', require('./routes/admin').router);

app.use((err, req, res, next) => {
  rid.error('unhandled', { err: err.message, stack: err.stack, path: req.path });
  // The request id is the whole point: a customer reporting a failure can quote
  // it, and it maps to exactly one log line.
  res.status(500).json({
    ok: false,
    error: 'internal',
    requestId: req.requestId,
    message: 'Something went wrong. Quote this request id to support.'
  });
});

app.use((req, res) =>
  res.status(404).json({ ok: false, error: 'not_found', requestId: req.requestId }));

const port = process.env.PORT || 8080;
app.listen(port, () => rid.info('gateway.started', { port, email: require('./mailer').PROVIDER }));
