import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState({ kind: 'ban', masterId: '', multiplier: 1.2, reason: '' });

  const load = () => api.rules().then((r) => setRules(r?.rules || []));
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    await api.addRule(form);
    setForm({ kind: 'ban', masterId: '', multiplier: 1.2, reason: '' });
    load();
  }

  return (
    <section>
      <h1>Merchandising rules</h1>
      <p className="muted">
        Bans apply before ranking, so a banned product cannot appear regardless
        of match quality. Set an expiry on anything seasonal.
      </p>

      <form className="inline" onSubmit={add}>
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="ban">Ban</option>
          <option value="boost">Boost</option>
          <option value="pin">Pin</option>
        </select>
        <input placeholder="Product ID" value={form.masterId}
               onChange={(e) => setForm({ ...form, masterId: e.target.value })} />
        {form.kind === 'boost' && (
          <input type="number" step="0.1" value={form.multiplier}
                 onChange={(e) => setForm({ ...form, multiplier: Number(e.target.value) })} />
        )}
        <input placeholder="Reason" value={form.reason}
               onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <button type="submit">Add</button>
      </form>

      <table>
        <thead>
          <tr><th>Type</th><th>Target</th><th>Reason</th><th>Expires</th><th></th></tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td><span className={`badge ${r.kind}`}>{r.kind}</span></td>
              <td><code>{r.master_id || JSON.stringify(r.attr_match)}</code></td>
              <td>{r.reason || '—'}</td>
              <td>{r.expires_at ? new Date(r.expires_at).toLocaleDateString() : 'never'}</td>
              <td>
                <button className="link" onClick={() => api.delRule(r.id).then(load)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
