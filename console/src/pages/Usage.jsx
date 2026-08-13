import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Usage() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.usage().then((r) => setRows(r?.usage || [])); }, []);

  return (
    <section>
      <h1>Usage</h1>
      <table>
        <thead>
          <tr><th>Period</th><th>Queries</th><th>Cache hit rate</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = Number(r.queries) ? Math.round(100 * r.cached / r.queries) : 0;
            return (
              <tr key={r.period}>
                <td>{new Date(r.period).toLocaleDateString(undefined,
                    { year: 'numeric', month: 'long' })}</td>
                <td>{r.queries}</td>
                <td>{rate}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        Cache hit rate is the main driver of unit cost. Below about 50% is worth
        investigating — usually it means query normalisation is too strict.
      </p>
    </section>
  );
}
