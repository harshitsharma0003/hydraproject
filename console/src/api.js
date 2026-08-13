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
  sites:   () => call('/api/console/sites'),
  rules:   () => call('/api/console/rules'),
  addRule: (r) => call('/api/console/rules', { method: 'POST', body: JSON.stringify(r) }),
  delRule: (id) => call(`/api/console/rules/${id}`, { method: 'DELETE' }),
  queries: () => call('/api/console/queries'),
  usage:   () => call('/api/console/usage'),
  syncs:   () => call('/api/console/syncs')
};
