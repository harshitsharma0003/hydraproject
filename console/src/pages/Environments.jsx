import { useEffect, useState } from 'react';
import { api } from '../api';

const ENV_LABEL = { production: 'Production', uat: 'UAT', sandbox: 'Sandbox' };

const ENV_NOTE = {
  production: 'Metered and billed. Cached responses expire after 1 hour.',
  uat: 'Not billed. Cached responses expire after 7 days.',
  sandbox: 'Not billed. Cache never expires, so repeat test runs cost nothing. '
         + 'Flush it if you are iterating on prompts or catalog data.'
};

export default function Environments() {
  const [data, setData] = useState(null);
  const [active, setActive] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.environments().then((r) => {
    setData(r);
    if (r?.environments?.length && !active) setActive(r.environments[0].site_id);
  });
  useEffect(() => { load(); }, []);

  if (!data) return <section><h1>Environments</h1><p className="muted">Loading…</p></section>;

  const envs = data.environments || [];
  const env = envs.find((e) => e.site_id === active) || envs[0];
  if (!env) {
    return (
      <section>
        <h1>Environments</h1>
        <p className="muted">No environments yet. Run the discovery job after installing.</p>
      </section>
    );
  }

  const pct = env.query_cap
    ? Math.min(100, Math.round(100 * env.queries_this_period / env.query_cap)) : 0;
  const cacheRate = env.queries_this_period
    ? Math.round(100 * env.cached_this_period / env.queries_this_period) : 0;

  async function rotate(kind) {
    if (!confirm(`Rotate the ${kind} key? The old one keeps working for 24 hours.`)) return;
    setBusy(true);
    const r = await api.rotateKey(env.site_id, kind);
    setBusy(false);
    if (r?.ok) { setRevealed(r); load(); }
  }

  async function flush() {
    setBusy(true);
    const r = await api.flushCache(env.site_id);
    setBusy(false);
    if (r?.ok) alert(`Flushed ${r.flushed} cached queries.`);
  }

  return (
    <section>
      <h1>Environments</h1>

      <div className="tabs">
        {envs.map((e) => (
          <button key={e.site_id}
                  className={`tab ${e.site_id === env.site_id ? 'active' : ''}`}
                  onClick={() => { setActive(e.site_id); setRevealed(null); }}>
            {ENV_LABEL[e.environment] || e.environment}
            {e.billable && <span className="dot" title="Billed" />}
          </button>
        ))}
      </div>

      <p className="muted">{ENV_NOTE[env.environment]}</p>

      <div className="metrics">
        <div className="metric">
          <span>Queries this month</span>
          <strong>{Number(env.queries_this_period).toLocaleString()}</strong>
          <small>of {Number(env.query_cap).toLocaleString()} cap</small>
        </div>
        <div className="metric">
          <span>Cache hit rate</span>
          <strong>{cacheRate}%</strong>
          <small>{Number(env.cached_this_period).toLocaleString()} served from cache</small>
        </div>
        <div className="metric">
          <span>Products indexed</span>
          <strong>{Number(env.masters_indexed).toLocaleString()}</strong>
          <small>{Number(env.masters_embedded).toLocaleString()} embedded</small>
        </div>
      </div>

      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <p className="muted" style={{ marginTop: 4 }}>
        {pct}% of cap used.
        {env.degraded_this_period > 0 &&
          ` ${Number(env.degraded_this_period).toLocaleString()} queries fell back to native search and were not charged.`}
      </p>

      <h2 style={{ marginTop: 28 }}>API keys</h2>
      <p className="muted">
        Keys are stored hashed and cannot be shown again after issue. Rotating
        generates a new one and displays it once.
      </p>

      {revealed && (
        <div className="reveal">
          <strong>Copy this now</strong>
          <code>{revealed.key}</code>
          <p className="muted">{revealed.note}</p>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Type</th><th>Key</th><th>Last used</th><th /></tr>
        </thead>
        <tbody>
          {(env.keys || []).map((k) => (
            <tr key={k.id}>
              <td>{k.kind === 'secret' ? 'Secret' : 'Publishable'}</td>
              <td><code>{k.masked}</code></td>
              <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}</td>
              <td>
                <button className="link" disabled={busy}
                        onClick={() => rotate(k.kind)}>Rotate</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 28 }}>Details</h2>
      <dl>
        <div><dt>Site</dt><dd>{env.external_site_id}</dd></div>
        <div><dt>Platform</dt><dd>{env.platform}</dd></div>
        <div><dt>Render mode</dt><dd>{env.render_mode}</dd></div>
        <div><dt>Cartridge</dt><dd>{env.cartridge_version || '—'}</dd></div>
        <div><dt>SFTP user</dt><dd>{env.sftp_username || 'not provisioned'}</dd></div>
        <div><dt>Last sync</dt>
             <dd>{env.last_sync_at ? new Date(env.last_sync_at).toLocaleString() : 'never'}</dd></div>
      </dl>

      {env.environment !== 'production' && (
        <button style={{ marginTop: 16 }} disabled={busy} onClick={flush}>
          Flush cached responses
        </button>
      )}
    </section>
  );
}
