import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The screen merchandisers actually log in for. Every widened query is a
 * catalog gap, a vocabulary gap, or a taxonomy gap.
 */
export default function Queries() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.queries().then((r) => setRows(r?.queries || [])); }, []);

  return (
    <section>
      <h1>Queries</h1>
      <p className="muted">
        Last 30 days, sorted by how often the search had to be widened. These are
        your catalog and vocabulary gaps.
      </p>

      <table>
        <thead>
          <tr><th>Query</th><th>Times asked</th><th>Widened</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.query} className={Number(r.widened) > 0 ? 'flag' : ''}>
              <td>{r.query}</td>
              <td>{r.hits}</td>
              <td>{r.widened}</td>
              <td>{new Date(r.last_seen).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
