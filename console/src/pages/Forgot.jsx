import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    await api.forgot(email);
    setBusy(false);
    // Always the same outcome, whether or not the account exists — otherwise
    // this page becomes a way to test which addresses are registered.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="login">
        <div className="panel">
          <h1>Check your inbox</h1>
          <p className="muted">
            If {email} has an account, a reset link is on its way. It expires in
            30 minutes and works once.
          </p>
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Reset your password</h1>
        <label>Email
          <input type="email" required value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        <p className="muted"><Link to="/login">Back to sign in</Link></p>
      </form>
    </div>
  );
}
