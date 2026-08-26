import { useEffect, useState } from 'react';
import { api } from '../api';

const usd = (micros) => '$' + Math.round(micros / 1000000).toLocaleString('en-US');

export default function Billing() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.billing().then(setData); }, []);
  if (!data) return <section><h1>Billing</h1><p className="muted">Loading…</p></section>;

  const current = (data.summary || [])[0];

  // Billing is sales-led — no self-serve card payment. Choosing a plan records
  // an upgrade request; the team provisions it manually.
  async function requestPlan(label) {
    setBusy(true);
    setMsg('');
    const r = await api.requestUpgrade(label);
    setBusy(false);
    setMsg(r?.ok
      ? `Thanks — we’ve logged your interest in ${label}. Our team will be in touch to activate it.`
      : 'Could not send the request. Please email sales@thinkvisor.io.');
  }

  return (
    <section>
      <h1>Billing</h1>
      <p className="muted">
        Plans are activated by our team — there is no card checkout here. Request
        a plan below or email <a href="mailto:sales@thinkvisor.io">sales@thinkvisor.io</a>.
      </p>

      {msg && <p className="warn">{msg}</p>}

      {current && (
        <>
          <div className="metrics">
            <div className="metric">
              <span>Billable queries this period</span>
              <strong>{Number(current.billable_queries).toLocaleString()}</strong>
              <small>{Number(current.included_queries).toLocaleString()} included</small>
            </div>
            <div className="metric">
              <span>Overage</span>
              <strong>{Number(current.overage_queries).toLocaleString()}</strong>
              <small>{usd(current.overage_micros)}</small>
            </div>
            <div className="metric">
              <span>Estimated total</span>
              <strong>{usd(Number(current.platform_fee_micros) + Number(current.overage_micros))}</strong>
              <small>plus GST</small>
            </div>
          </div>

          <p className="muted">
            {Number(current.nonprod_queries).toLocaleString()} sandbox and UAT
            queries were not charged.
            {current.degraded_queries > 0 &&
              ` ${Number(current.degraded_queries).toLocaleString()} queries fell back to native search and were not charged.`}
          </p>
        </>
      )}

      <h2 style={{ marginTop: 28 }}>Plan</h2>
      <div className="plans">
        {Object.entries(data.plans).filter(([k]) => k !== 'trial').map(([k, p]) => (
          <div className="plan" key={k}>
            <h3>{p.label}</h3>
            <div className="price">
              <span style={{ textDecoration: 'line-through', opacity: 0.45, fontWeight: 400, marginRight: 8 }}>{usd(p.fee * 2)}</span>
              {usd(p.fee)}<span>/month</span>
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: '#0f6e56', background: '#e1f5ee', borderRadius: 999, padding: '2px 8px', verticalAlign: 'middle' }}>50% off</span>
            </div>
            <p className="muted">{p.included.toLocaleString()} queries included</p>
            <button disabled={busy} onClick={() => requestPlan(p.label)}>
              Request {p.label}
            </button>
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        Prepaid credit blocks and annual pricing are available on request.
      </p>

      <h2 style={{ marginTop: 28 }}>Invoices</h2>
      <table>
        <thead><tr><th>Period</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>
          {(data.invoices || []).map((i) => (
            <tr key={i.period}>
              <td>{new Date(i.period).toLocaleDateString(undefined,
                   { year: 'numeric', month: 'long' })}</td>
              <td>{usd(i.total_micros)}</td>
              <td><span className={`badge ${i.status === 'paid' ? 'on' : ''}`}>{i.status}</span></td>
            </tr>
          ))}
          {!(data.invoices || []).length && (
            <tr><td colSpan="3" className="muted">No invoices yet.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
