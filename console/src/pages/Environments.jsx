import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../Toast';

const ENV_LABEL = { production: 'Production', uat: 'UAT', sandbox: 'Sandbox' };

const ENV_NOTE = {
  production: 'Metered and billed. Cached responses expire after 1 hour.',
  uat: 'Not billed. Cached responses expire after 7 days.',
  sandbox: 'Not billed. Cache never expires, so repeat test runs cost nothing. '
         + 'Flush it if you are iterating on prompts or catalog data.'
};

export default function Environments() {
  const { notify, confirm } = useToast();
  const [data, setData] = useState(null);
  const [active, setActive] = useState(null);
  const [revealed, setRevealed] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(true);

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

  // Postgres returns bigints as strings, so `"0" ? … : …` took the truthy branch
  // and computed 0/0 = NaN. Coerce everything to numbers before the maths.
  const queries = Number(env.queries_this_period) || 0;
  const cap = Number(env.query_cap) || 0;
  const cached = Number(env.cached_this_period) || 0;
  const masters = Number(env.masters_indexed) || 0;
  const embedded = Number(env.masters_embedded) || 0;
  const degraded = Number(env.degraded_this_period) || 0;
  const pct = cap ? Math.min(100, Math.round((100 * queries) / cap)) : 0;
  const cacheRate = queries ? Math.round((100 * cached) / queries) : 0;

  const keys = env.keys || [];
  const keyFor = (kind) => keys.find((k) => k.kind === kind);
  const hasBothKeys = !!keyFor('publishable') && !!keyFor('secret');
  const hasUat = envs.some((e) => e.environment === 'uat');
  const connected = !!env.last_sync_at || masters > 0 || !!env.sftp_username;

  async function issue(kind) {
    const existing = !!keyFor(kind);
    if (existing) {
      const ok = await confirm(
        `Rotate the ${kind} key? The old one keeps working for 24 hours so your `
        + `storefront stays up while you update it.`, 'Rotate');
      if (!ok) return null;
    }
    setBusy(true);
    const r = await api.rotateKey(env.site_id, kind);
    setBusy(false);
    if (r?.ok) {
      setRevealed((prev) => [...prev.filter((x) => x.kind !== kind),
        { kind, key: r.key, note: r.note }]);
      notify(existing ? 'Key rotated. Copy it now.' : 'Key generated. Copy it now.', 'success');
      await load();
      return r;
    }
    notify('Could not issue the key.', 'danger');
    return null;
  }

  async function generateBoth() {
    setRevealed([]);
    if (!keyFor('publishable')) await issue('publishable');
    if (!keyFor('secret')) await issue('secret');
  }

  async function addEnvironment(environment) {
    setBusy(true);
    const r = await api.createEnvironment(environment);
    setBusy(false);
    if (r?.ok) {
      notify(`${ENV_LABEL[environment]} environment created.`, 'success');
      await load();
      setActive(r.siteId);
      setRevealed([]);
    } else {
      notify(r?.error === 'environment_exists'
        ? `A ${environment} environment already exists.`
        : 'Could not create the environment.', 'danger');
    }
  }

  async function flush() {
    setBusy(true);
    const r = await api.flushCache(env.site_id);
    setBusy(false);
    if (r?.ok) notify(`Flushed ${r.flushed} cached queries.`, 'success');
    else notify('Could not flush the cache.', 'danger');
  }

  const steps = [
    { done: hasBothKeys, title: 'Generate your API keys',
      desc: 'A publishable key for the storefront and a secret key for server calls. Each is shown once.',
      action: !hasBothKeys && { label: 'Generate keys', fn: generateBoth } },
    { done: hasUat, title: 'Add a UAT environment',
      desc: 'A staging environment with its own keys and quota, never billed — so QA never eats production allowance.',
      action: !hasUat && { label: 'Add UAT', fn: () => addEnvironment('uat') } },
    { done: connected, title: 'Connect your storefront',
      desc: 'Install the cartridge (SFCC) or the app (Shopify), paste the keys above, and point it at your gateway URL.' },
    { done: masters > 0, title: 'Sync your catalog',
      desc: 'Upload your catalog over SFTP. Discovery embeds it in the background — prices and stock never leave your instance.' }
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <section>
      <h1>Environments</h1>

      {showGuide && !allDone && (
        <div className="ob">
          <div className="ob-head">
            <div>
              <h2>Get started</h2>
              <p className="muted">Four steps to your first natural-language search. {doneCount} of {steps.length} done.</p>
            </div>
            <button className="link" onClick={() => setShowGuide(false)}>Hide</button>
          </div>
          <div className="ob-progress"><div style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <ol className="ob-steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? 'done' : ''}>
                <span className="ob-mark">{s.done ? '✓' : i + 1}</span>
                <div className="ob-body">
                  <strong>{s.title}</strong>
                  <p className="muted">{s.desc}</p>
                </div>
                {s.action && (
                  <button disabled={busy} onClick={s.action.fn}>{s.action.label}</button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="tabs">
        {envs.map((e) => (
          <button key={e.site_id}
                  className={`tab ${e.site_id === env.site_id ? 'active' : ''}`}
                  onClick={() => { setActive(e.site_id); setRevealed([]); }}>
            {ENV_LABEL[e.environment] || e.environment}
            {e.billable && <span className="dot" title="Billed" />}
          </button>
        ))}
        {!hasUat && (
          <button className="tab add" disabled={busy}
                  onClick={() => addEnvironment('uat')} title="Create a UAT environment">＋ UAT</button>
        )}
        <button className="tab add" disabled={busy}
                onClick={() => addEnvironment('production')} title="Create a production environment">＋ Production</button>
      </div>

      <p className="muted">{ENV_NOTE[env.environment]}</p>

      <div className="metrics">
        <div className="metric">
          <span>Queries this month</span>
          <strong>{queries.toLocaleString()}</strong>
          <small>of {cap.toLocaleString()} cap</small>
        </div>
        <div className="metric">
          <span>Cache hit rate</span>
          <strong>{cacheRate}%</strong>
          <small>{cached.toLocaleString()} served from cache</small>
        </div>
        <div className="metric">
          <span>Products indexed</span>
          <strong>{masters.toLocaleString()}</strong>
          <small>{embedded.toLocaleString()} embedded</small>
        </div>
      </div>

      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <p className="muted" style={{ marginTop: 4 }}>
        {pct}% of cap used.
        {degraded > 0 &&
          ` ${degraded.toLocaleString()} queries fell back to native search and were not charged.`}
      </p>

      <h2 style={{ marginTop: 28 }}>API keys</h2>
      <p className="muted">
        Keys are stored hashed and shown only once, at the moment you generate
        them. If you lose one, rotate it to issue a fresh key.
      </p>

      {revealed.map((r) => (
        <div className="reveal" key={r.kind}>
          <strong>Copy your {r.kind} key now</strong>
          <code>{r.key}</code>
          <p className="muted">{r.note}</p>
        </div>
      ))}

      <table>
        <thead>
          <tr><th>Type</th><th>Key</th><th>Last used</th><th /></tr>
        </thead>
        <tbody>
          {['publishable', 'secret'].map((kind) => {
            const k = keyFor(kind);
            return (
              <tr key={kind}>
                <td>{kind === 'secret' ? 'Secret' : 'Publishable'}</td>
                <td>{k ? <code>{k.masked}</code> : <span className="muted">not generated</span>}</td>
                <td>{k?.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : (k ? 'never' : '—')}</td>
                <td>
                  <button className="link" disabled={busy} onClick={() => issue(kind)}>
                    {k ? 'Rotate' : 'Generate'}
                  </button>
                </td>
              </tr>
            );
          })}
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
