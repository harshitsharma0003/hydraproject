'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

/**
 * Request correlation.
 *
 * Every response and every log line carries the same id, so a customer saying
 * "it broke at 3pm" becomes a single grep instead of an investigation. The id
 * also travels to the storefront, which surfaces it in Algivo-Health — support
 * conversations start with "quote me the request id".
 *
 * AsyncLocalStorage means log() picks up the id without threading it through
 * every function signature.
 */

const als = new AsyncLocalStorage();

function middleware(req, res, next) {
  // Honour an inbound id so a cartridge request and the gateway work on it
  // share one trace. Validated, because it ends up in logs.
  const inbound = req.get('X-Request-Id');
  const id = (inbound && /^[A-Za-z0-9_-]{8,64}$/.test(inbound))
    ? inbound
    : crypto.randomUUID();

  req.requestId = id;
  res.set('X-Request-Id', id);

  const started = Date.now();
  res.on('finish', () => {
    log('info', 'request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      tenant: req.algivo?.tenant_id || req.user?.tenant_id || null,
      env: req.algivo?.environment || null
    });
  });

  als.run({ requestId: id }, () => next());
}

function currentId() {
  return als.getStore()?.requestId || null;
}

/** Structured JSON lines — greppable, and parseable by any log shipper. */
function log(level, message, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    requestId: currentId(),
    ...fields
  };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  middleware,
  currentId,
  log,
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f)
};
