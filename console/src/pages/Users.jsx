import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Users() {
  const [data, setData] = useState(null);
  const [invite, setInvite] = useState({ email: '', role: 'viewer', siteIds: [] });
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.users().then(setData);
  useEffect(() => { load(); }, []);

  if (!data) return <section><h1>Users</h1><p className="muted">Loading…</p></section>;

  const canWrite = ['owner', 'admin'].includes(data.me.role);
  const isOwner = data.me.role === 'owner';

  async function send(e) {
    e.preventDefault();
    setError(''); setLink(null);
    if (!invite.email) return setError('Enter an email address.');
    const r = await api.inviteUser(invite);
    if (!r?.ok) {
      return setError(r?.error === 'already_a_member'
        ? 'That person is already on this account.' : 'Could not send the invite.');
    }
    setLink(r.inviteUrl);
    setInvite({ email: '', role: 'viewer', siteIds: [] });
    load();
  }

  async function act(fn, ...args) {
    const r = await fn(...args);
    if (!r?.ok) setError(r?.error || 'That did not work.');
    else setError('');
    load();
  }

  return (
    <section>
      <h1>Users</h1>
      <p className="muted">
        Developers and merchandisers can be limited to specific sites. Owners and
        admins always have access to everything.
      </p>

      {error && <p className="error">{error}</p>}

      {canWrite && (
        <>
          <form className="inline" onSubmit={send}>
            <input type="email" placeholder="name@company.com" value={invite.email}
                   onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <select value={invite.role}
                    onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              {Object.keys(data.roles)
                .filter((r) => r !== 'owner' || isOwner)
                .map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit">Send invite</button>
          </form>
          <p className="muted">{data.roles[invite.role]}</p>

          {link && (
            <div className="reveal">
              <strong>Invite link</strong>
              <code>{link}</code>
              <p className="muted">
                Email delivery is not wired up yet — send this to them directly.
                It expires in 7 days and works once.
              </p>
            </div>
          )}
        </>
      )}

      <table>
        <thead>
          <tr><th>User</th><th>Role</th><th>Sites</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {data.users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name || u.email}
                <div className="muted">{u.email}</div>
              </td>
              <td>
                {canWrite && u.id !== data.me.id
                  ? (
                    <select value={u.role}
                            onChange={(e) => act(api.setUserRole, u.id, e.target.value)}>
                      {Object.keys(data.roles)
                        .filter((r) => r !== 'owner' || isOwner)
                        .map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  )
                  : <span className="badge">{u.role}</span>}
              </td>
              <td className="muted">
                {u.all_sites ? 'All sites' : (u.scoped_sites || []).join(', ') || '—'}
              </td>
              <td>
                <span className={`badge ${u.status === 'active' ? 'on' : 'off'}`}>
                  {u.locked ? 'locked' : u.status}
                </span>
              </td>
              <td>
                {canWrite && u.id !== data.me.id && (
                  u.status === 'active'
                    ? <button className="link" onClick={() => act(api.suspendUser, u.id)}>Suspend</button>
                    : <button className="link" onClick={() => act(api.reactivateUser, u.id)}>Reactivate</button>
                )}
                {u.id === data.me.id && <span className="muted">You</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!!data.invites.length && (
        <>
          <h2 style={{ marginTop: 28 }}>Pending invites</h2>
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {data.invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td><span className="badge">{i.role}</span></td>
                  <td className="muted">{new Date(i.expires_at).toLocaleDateString()}</td>
                  <td>
                    {canWrite &&
                      <button className="link" onClick={() => act(api.revokeInvite, i.id)}>
                        Revoke
                      </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
