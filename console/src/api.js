const BASE = import.meta.env.VITE_GATEWAY_URL || '';

function token() { return localStorage.getItem('algivo_token'); }

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(options.headers || {})
    }
  });
  const requestId = res.headers.get('X-Request-Id');
  if (res.status === 401) {
    localStorage.removeItem('algivo_token');
    window.location.href = '/login';
    return null;
  }
  const body = await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  // Every response carries the trace id, so an error message can quote
  // something support can actually search for.
  return requestId ? { ...body, requestId } : body;
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
  users:   () => call('/api/users'),
  inviteUser: (b) => call('/api/users/invite', { method: 'POST', body: JSON.stringify(b) }),
  acceptInvite: (b) => call('/api/invites/accept', { method: 'POST', body: JSON.stringify(b) }),
  setUserRole: (id, role) =>
    call(`/api/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) }),
  setUserSites: (id, siteIds) =>
    call(`/api/users/${id}/sites`, { method: 'POST', body: JSON.stringify({ siteIds }) }),
  suspendUser: (id) => call(`/api/users/${id}/suspend`, { method: 'POST' }),
  reactivateUser: (id) => call(`/api/users/${id}/reactivate`, { method: 'POST' }),
  revokeInvite: (id) => call(`/api/users/invites/${id}/revoke`, { method: 'POST' }),
  audit:   () => call('/api/audit'),
  forgot:  (email) => call('/api/auth/forgot',
             { method: 'POST', body: JSON.stringify({ email }) }),
  checkReset: (token) => call(`/api/auth/reset/check?token=${encodeURIComponent(token)}`),
  resetPassword: (token, password) => call('/api/auth/reset',
             { method: 'POST', body: JSON.stringify({ token, password }) }),
  changePassword: (current, password) => call('/api/auth/change-password',
             { method: 'POST', body: JSON.stringify({ current, password }) }),
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
