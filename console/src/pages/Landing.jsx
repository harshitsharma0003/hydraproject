import { Link } from 'react-router-dom';

const PLANS = [
  { id: 'starter', name: 'Starter', price: '₹18,000', queries: '40,000',
    features: ['Sandbox + production', 'Merchandiser ban list', 'Email support'] },
  { id: 'growth', name: 'Growth', price: '₹65,000', queries: '250,000', featured: true,
    features: ['Sandbox, UAT + production', 'Full console', 'AI narration', 'Shared Slack'] },
  { id: 'enterprise', name: 'Enterprise', price: '₹2,25,000', queries: '1,000,000',
    features: ['Unlimited non-production', 'SLA + named contact', 'Dedicated index partition'] }
];

export default function Landing() {
  return (
    <div className="public">
      <header>
        <span className="brand">Hydra</span>
        <nav>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className="cta">Start free</Link>
        </nav>
      </header>

      <section className="hero">
        <h1>Your shoppers describe what they want. Hydra builds the page.</h1>
        <p>
          Natural-language merchandising for Salesforce B2C Commerce and Shopify.
          Results render through your own PLP — your templates, your prices, your
          stock. Nothing to restyle.
        </p>
        <Link to="/signup" className="cta big">Start free with a sandbox</Link>
        <p className="fine">No card required. Sandbox is free forever.</p>
      </section>

      <section className="how">
        <div><h3>1. Install</h3><p>Drop in the cartridge or install the Shopify app. Auto-discovery reads your catalog and attributes.</p></div>
        <div><h3>2. Sync</h3><p>Your catalog uploads over SFTP. Prices and stock never leave your instance.</p></div>
        <div><h3>3. Go live</h3><p>Results render through your existing product tiles. Turn it off from a single preference.</p></div>
      </section>

      <section id="pricing" className="pricing">
        <h2>Pricing</h2>
        <p className="muted">Per month, plus GST. Sandbox and UAT are never billed.</p>
        <div className="plans">
          {PLANS.map((p) => (
            <div className={`plan ${p.featured ? 'featured' : ''}`} key={p.id}>
              {p.featured && <span className="tag">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="price">{p.price}<span>/month</span></div>
              <p className="muted">{p.queries} production queries included</p>
              <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              <Link to={`/signup?plan=${p.id}`} className="cta">Get started</Link>
            </div>
          ))}
        </div>
        <p className="fine">
          Overage from ₹0.30 per query, or buy prepaid blocks. Queries that fall
          back to your native search are never charged.
        </p>
      </section>

      <footer>
        <span>© 2026 Hydra</span>
        <a href="mailto:sales@hydra.example.com">sales@hydra.example.com</a>
      </footer>
    </div>
  );
}
