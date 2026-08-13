import { useEffect, useState } from 'react';
import { api } from '../api';

const inr = (micros) => '₹' + Math.round(micros / 1000000).toLocaleString('en-IN');

export default function Billing() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => { api.billing().then(setData); }, []);
  if (!data) return <section><h1>Billing</h1><p className="muted">Loading…</p></section>;

  const current = (data.summary || [])[0];

  async function upgrade(tier) {
    setMsg('');
    const r = await api.checkout(tier);
    if (r?.url) window.location.assign(r.url);       // Stripe Checkout
    else setMsg('Payments are not enabled on this instance yet. Once Stripe keys '
      + 'are configured, this will open secure checkout.');
  }

  async function buyCredits() {
    setMsg('');
    const r = await api.buyCredits(1);
    if (r?.url) window.location.assign(r.url);
    else setMsg('Payments are not enabled on this instance yet.');
  }

  return (
    <section>
      <h1>Billing</h1>

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
              <small>{inr(current.overage_micros)}</small>
            </div>
            <div className="metric">
              <span>Estimated total</span>
              <strong>{inr(Number(current.platform_fee_micros) + Number(current.overage_micros))}</strong>
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

      <h2 style={{ marginTop: 28 }}>Prepaid credits</h2>
      <p className="muted">
        Balance: {data.credits.toLocaleString()} queries. Blocks of 50,000 avoid
        overage on the invoice.
      </p>
      <button onClick={buyCredits}>Buy a credit block</button>

      <h2 style={{ marginTop: 28 }}>Plan</h2>
      <div className="plans">
        {Object.entries(data.plans).filter(([k]) => k !== 'trial').map(([k, p]) => (
          <div className="plan" key={k}>
            <h3>{p.label}</h3>
            <div className="price">{inr(p.fee)}<span>/month</span></div>
            <p className="muted">{p.included.toLocaleString()} queries included</p>
            <button onClick={() => upgrade(k)}>Choose {p.label}</button>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: 28 }}>Invoices</h2>
      <table>
        <thead><tr><th>Period</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>
          {(data.invoices || []).map((i) => (
            <tr key={i.period}>
              <td>{new Date(i.period).toLocaleDateString(undefined,
                   { year: 'numeric', month: 'long' })}</td>
              <td>{inr(i.total_micros)}</td>
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
