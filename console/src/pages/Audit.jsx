import { useEffect, useState } from 'react';
import { api } from '../api';

const LABEL = {
  'user.login': 'Signed in',
  'user.invited': 'Invited a user',
  'user.role_changed': 'Changed a role',
  'user.sites_changed': 'Changed site access',
  'user.suspended': 'Suspended a user',
  'user.reactivated': 'Reactivated a user',
  'user.removed': 'Removed a user',
  'invite.revoked': 'Revoked an invite',
  'keys.rotated': 'Rotated an API key',
  'rules.created': 'Added a merchandising rule',
  'cache.flushed': 'Flushed cached responses'
};

export default function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.audit().then((r) => setRows(r?.entries || [])); }, []);

  return (
    <section>
      <h1>Audit log</h1>
      <p className="muted">
        Every change to users, keys and rules. Append-only — entries cannot be
        edited or deleted, including by owners.
      </p>
      <table>
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.actor_email || 'system'}</td>
              <td>{LABEL[r.action] || r.action}</td>
              <td className="muted">
                {r.target_id || ''}
                {r.detail?.role && ` → ${r.detail.role}`}
                {r.detail?.kind && ` (${r.detail.kind})`}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="4" className="muted">Nothing yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
