const BASE = import.meta.env.VITE_GATEWAY_URL || '';

function token() { return localStorage.getItem('hydra_token'); }

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    localStorage.removeItem('hydra_token');
    window.location.href = '/login';
    return null;
  }
  return res.json();
}

export const api = {
  login: (email, password) =>
    call('/api/console/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signup:  (b) => call('/api/signup', { method: 'POST', body: JSON.stringify(b) }),
  environments: () => call('/api/environments'),
  rotateKey: (siteId, kind) =>
    call('/api/keys/rotate', { method: 'POST', body: JSON.stringify({ siteId, kind }) }),
  flushCache: (siteId) =>
    call('/api/console/cache/flush', { method: 'POST', body: JSON.stringify({ siteId }) }),
  billing: () => call('/api/billing'),
  checkout: (tier) =>
    call('/api/checkout', { method: 'POST', body: JSON.stringify({ tier }) }),
  buyCredits: (blocks) =>
    call('/api/credits/purchase', { method: 'POST', body: JSON.stringify({ blocks }) }),
  sites:   () => call('/api/console/sites'),
  rules:   () => call('/api/console/rules'),
  addRule: (r) => call('/api/console/rules', { method: 'POST', body: JSON.stringify(r) }),
  delRule: (id) => call(`/api/console/rules/${id}`, { method: 'DELETE' }),
  queries: () => call('/api/console/queries'),
  usage:   () => call('/api/console/usage'),
  syncs:   () => call('/api/console/syncs')
};
