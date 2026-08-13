import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';

export default function Signup() {
  const [form, setForm] = useState({ email: '', password: '', company: '',
                                     platform: 'sfcc_sfra' });
  const [error, setError] = useState('');
  const [keys, setKeys] = useState(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const nav = useNavigate();

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (form.password.length < 10) return setError('Use at least 10 characters.');
    setBusy(true);
    const r = await api.signup(form);
    setBusy(false);
    if (!r?.ok) {
      return setError(r?.error === 'email_taken'
        ? 'That email already has an account.' : 'Could not create the account.');
    }
    localStorage.setItem('algivo_token', r.token);
    setKeys(r.keys);
  }

  // Keys are shown exactly once - they are stored hashed and cannot be
  // recovered, only rotated. So this screen blocks until acknowledged.
  if (keys) {
    return (
      <div className="login">
        <div className="panel">
          <h1>Your sandbox is ready</h1>
          <p className="muted">
            Copy these now. They are stored hashed and cannot be shown again.
          </p>
          <label>Publishable key<code>{keys.publishableKey}</code></label>
          <label>Secret key<code>{keys.secretKey}</code></label>
          <p className="muted">
            Paste them into your sandbox instance. Production keys are issued
            when you choose a plan.
          </p>
          <button onClick={() => nav(params.get('plan') ? '/billing' : '/')}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Start free</h1>
        <p className="muted">Sandbox access, no card required.</p>
        <label>Work email
          <input type="email" required value={form.email} onChange={set('email')} />
        </label>
        <label>Company
          <input type="text" value={form.company} onChange={set('company')} />
        </label>
        <label>Platform
          <select value={form.platform} onChange={set('platform')}>
            <option value="sfcc_sfra">Salesforce B2C Commerce (SFRA)</option>
            <option value="shopify">Shopify</option>
          </select>
        </label>
        <label>Password
          <input type="password" required value={form.password} onChange={set('password')} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className="muted">Already have one? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
