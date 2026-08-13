import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Sites() {
  const [sites, setSites] = useState([]);
  useEffect(() => { api.sites().then((r) => setSites(r?.sites || [])); }, []);

  return (
    <section>
      <h1>Sites</h1>
      {!sites.length && <p className="muted">No sites yet. Run the discovery job.</p>}

      {sites.map((s) => (
        <article key={s.id} className="card">
          <header>
            <h2>{s.external_site_id}</h2>
            <span className={`badge ${s.render_mode === 'off' ? 'off' : 'on'}`}>
              {s.render_mode}
            </span>
          </header>

          <dl>
            <div><dt>Platform</dt><dd>{s.platform}</dd></div>
            <div><dt>Locales</dt><dd>{(s.locales || []).join(', ') || '—'}</dd></div>
            <div><dt>Tile template</dt><dd><code>{s.tile_template || '—'}</code></dd></div>
            <div><dt>Cartridge</dt><dd>{s.cartridge_version || '—'}</dd></div>
          </dl>

          {s.findings && (
            <div className="findings">
              <h3>Discovery report</h3>
              <p>
                Found {s.findings.attributesFound} attributes,
                mapped {s.findings.attributesMapped}.
                {s.findings.attributesNeedingReview > 0 &&
                  ` ${s.findings.attributesNeedingReview} need review.`}
              </p>
              {s.findings.searchContested && (
                <p className="warn">
                  Another cartridge already extends Search.js. Staying on
                  route_only until the cartridge path puts Algivo ahead of it.
                </p>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
