import { useEffect, useState } from 'react';
import { api } from '../api';

const LABEL = {
  open: 'Waiting for upload', uploading: 'Uploading', manifest_received: 'Queued',
  loading: 'Loading', promoting: 'Promoting', embedding: 'Embedding',
  complete: 'Complete', failed: 'Failed', aborted: 'Aborted'
};

export default function Syncs() {
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    const load = () => api.syncs().then((r) => setJobs(r?.jobs || []));
    load();
    // Ingest and embedding run in the background, so poll while any job is live.
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <section>
      <h1>Catalog, price &amp; inventory syncs</h1>
      <p className="muted">
        Your catalogue, prices and inventory stay in sync. Products remain
        searchable throughout — embeddings are replaced one batch at a time,
        never cleared upfront.
      </p>

      <table>
        <thead>
          <tr><th>Started</th><th>Mode</th><th>Via</th><th>State</th>
              <th>Rows</th><th>Embedding left</th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className={j.state === 'failed' ? 'flag' : ''}>
              <td>{new Date(j.created_at).toLocaleString()}</td>
              <td>{j.mode}</td>
              <td>{j.transport}</td>
              <td>
                <span className={`badge ${j.state === 'complete' ? 'on'
                                : j.state === 'failed' ? 'off' : ''}`}>
                  {LABEL[j.state] || j.state}
                </span>
                {j.error && <div className="muted">{j.error}</div>}
              </td>
              <td>{j.rows_promoted || j.rows_loaded || 0}</td>
              <td>{j.embed_remaining > 0 ? j.embed_remaining : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
