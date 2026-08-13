import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setError('');
    const res = await api.login(email, password);
    if (res?.ok) {
      localStorage.setItem('algivo_token', res.token);
      nav('/');
    } else {
      setError('Those credentials did not work.');
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Algivo</h1>
        <label>Email
          <input type="email" value={email} required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>Password
          <input type="password" value={password} required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Sign in</button>
        <p className="muted"><Link to="/forgot">Forgot your password?</Link></p>
      </form>
    </div>
  );
}
