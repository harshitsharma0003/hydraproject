import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', password: '' });
  const [error, setError] = useState('');
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    if (form.password.length < 10) return setError('Use at least 10 characters.');
    const r = await api.acceptInvite({ token: params.get('token'), ...form });
    if (!r?.ok) return setError('This invite is invalid or has expired.');
    localStorage.setItem('hydra_token', r.token);
    nav('/');
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Join the account</h1>
        <label>Your name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>Choose a password
          <input type="password" required value={form.password}
                 onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Join</button>
      </form>
    </div>
  );
}
