import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api';

export default function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [valid, setValid] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();

  // Check before showing the form, so an expired link fails immediately rather
  // than after someone has typed a new password twice.
  useEffect(() => {
    if (!token) return setValid(false);
    api.checkReset(token).then((r) => setValid(!!r?.ok));
  }, [token]);

  if (valid === null) return <div className="login"><p className="muted">Checking…</p></div>;

  if (!valid) {
    return (
      <div className="login">
        <div className="panel">
          <h1>This link has expired</h1>
          <p className="muted">Reset links last 30 minutes and work once.</p>
          <Link to="/forgot">Request a new one</Link>
        </div>
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    if (password.length < 10) return setError('Use at least 10 characters.');
    if (password !== confirm) return setError('Those do not match.');
    const r = await api.resetPassword(token, password);
    if (!r?.ok) return setError(r?.message || 'That did not work.');
    localStorage.setItem('algivo_token', r.token);
    nav('/');
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Choose a new password</h1>
        <label>New password
          <input type="password" required value={password}
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>Confirm
          <input type="password" required value={confirm}
                 onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <p className="muted">
          Setting a new password signs out every other session.
        </p>
        <button type="submit">Set password</button>
      </form>
    </div>
  );
}
