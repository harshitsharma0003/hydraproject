import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../Logo';
import { api } from '../api';

/* ------------------------------------------------------------------ *
 * Interactive hero demo. These are illustrative — no backend call —
 * but they show the one idea exactly: a shopper describes intent, and
 * Algivo assembles a relevant grid rendered as the merchant's own tiles.
 * ------------------------------------------------------------------ */
const DEMOS = [
  {
    q: 'outfit for a summer wedding',
    chips: ['Dresses', 'Occasion · Wedding', 'Season · Summer', 'Under ₹8,000'],
    tiles: [
      { n: 'Chiffon Midi Dress', p: '₹6,490', h: 338 },
      { n: 'Block-Heel Sandals', p: '₹3,200', h: 28 },
      { n: 'Pearl Drop Earrings', p: '₹1,150', h: 46 },
      { n: 'Silk Wrap Gown', p: '₹7,900', h: 300 },
      { n: 'Woven Clutch', p: '₹2,400', h: 20 },
      { n: 'Strappy Slingbacks', p: '₹4,100', h: 350 }
    ]
  },
  {
    q: 'cozy gifts for my mom under ₹3000',
    chips: ['Gifting', 'Recipient · Her', 'Price < ₹3,000', 'Home & Comfort'],
    tiles: [
      { n: 'Merino Throw Blanket', p: '₹2,750', h: 12 },
      { n: 'Scented Candle Trio', p: '₹1,499', h: 32 },
      { n: 'Cashmere Socks', p: '₹990', h: 210 },
      { n: 'Herbal Tea Sampler', p: '₹850', h: 90 },
      { n: 'Ceramic Mug Set', p: '₹1,600', h: 190 },
      { n: 'Lavender Bath Kit', p: '₹2,200', h: 270 }
    ]
  },
  {
    q: 'minimalist looks for the office',
    chips: ['Workwear', 'Style · Minimal', 'Neutral palette', 'New in'],
    tiles: [
      { n: 'Tailored Trousers', p: '₹4,600', h: 220 },
      { n: 'Oversized Blazer', p: '₹8,900', h: 210 },
      { n: 'Cotton Poplin Shirt', p: '₹2,990', h: 200 },
      { n: 'Leather Tote', p: '₹9,500', h: 30 },
      { n: 'Pointed Flats', p: '₹3,800', h: 224 },
      { n: 'Fine-Knit Roll Neck', p: '₹3,300', h: 205 }
    ]
  },
  {
    q: 'waterproof trail running shoes',
    chips: ['Footwear · Trail', 'Waterproof', 'Activity · Running', 'Grip'],
    tiles: [
      { n: 'GTX Trail Runner', p: '₹11,200', h: 150 },
      { n: 'All-Terrain Low', p: '₹8,700', h: 168 },
      { n: 'Storm Trail Mid', p: '₹12,900', h: 200 },
      { n: 'Grip Runner Pro', p: '₹9,900', h: 130 },
      { n: 'Rugged Waterproof', p: '₹10,400', h: 180 },
      { n: 'Ridge Runner GTX', p: '₹13,500', h: 158 }
    ]
  }
];

const BENEFITS = [
  { icon: 'chat', t: 'Search that understands intent',
    d: 'Shoppers type the way they think — "something for a beach holiday" — and get a curated page, not a zero-results dead end.' },
  { icon: 'grid', t: 'Zero restyling',
    d: 'Results render through your existing product tiles and PLP templates. No new components, no design work, no brand drift.' },
  { icon: 'shield', t: 'Your prices stay yours',
    d: 'Algivo returns product IDs, never prices or stock. Price, promotions and inventory resolve live in the shopper’s own session — always correct.' },
  { icon: 'bolt', t: 'Never an outage',
    d: 'If Algivo is ever unreachable, the storefront silently falls back to native search. A gateway blip can never take your site down.' },
  { icon: 'spark', t: 'Personalised, safely',
    d: 'Rankings adapt to on-site behaviour — never leaking one shopper’s history to another, and never personalising a gift query.' },
  { icon: 'dial', t: 'Merchandiser control',
    d: 'Ban, pin and boost products from the console. The model proposes; your team stays in charge of what customers see.' }
];

const PLANS = [
  { id: 'starter', name: 'Basic', price: '$200', queries: '50,000',
    features: ['Dedicated VM — up to 2.5L SKUs', 'Sandbox + production', '$0.01 / extra query', 'Email support'] },
  { id: 'growth', name: 'Growth', price: '$400', queries: '250,000', featured: true,
    features: ['Dedicated high-performance VM — up to 5L SKUs', 'Sandbox, UAT + production', 'AI narration', '$0.008 / extra query', 'Developer & integration support'] },
  { id: 'enterprise', name: 'Enterprise', price: '$800', queries: '1,000,000+',
    features: ['Dedicated + HA infrastructure', 'AI narration + tuned models', '$0.005 / extra query', 'Dedicated engineer + SLA'] }
];

function Icon({ name }) {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9z" />,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
    dial: <><circle cx="12" cy="12" r="9" /><path d="M12 12l4-2" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></>
  };
  return <svg {...p}>{paths[name]}</svg>;
}

export default function Landing() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef(null);

  const [form, setForm] = useState({ name: '', email: '', company: '', plan: '', message: '' });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const pickPlan = (planName) => {
    setForm((f) => ({ ...f, plan: planName }));
    document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' });
  };
  const submitContact = async (e) => {
    e.preventDefault();
    setErr('');
    if (!form.email) return setErr('Please enter a work email.');
    setSending(true);
    const r = await api.contact(form);
    setSending(false);
    if (r?.ok) setSent(true);
    else setErr('Could not send — please email sales@thinkvisor.io directly.');
  };

  useEffect(() => {
    if (paused) return undefined;
    timer.current = setInterval(() => setActive((i) => (i + 1) % DEMOS.length), 3800);
    return () => clearInterval(timer.current);
  }, [paused]);

  const demo = DEMOS[active];

  return (
    <div className="lp">
      <header className="lp-head">
        <Logo size={28} />
        <nav>
          <a href="#benefits">Benefits</a>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className="lp-btn">Start free</Link>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow">AI merchandising for SFCC &amp; Shopify</span>
          <h1>Your shoppers describe what they want.<br /><em>Algivo builds the page.</em></h1>
          <p>
            Natural-language search that returns a curated PLP — rendered through
            your own product tiles, your live prices, your real stock. Nothing to
            restyle, nothing that can take your storefront down.
          </p>
          <div className="lp-hero-cta">
            <Link to="/signup" className="lp-btn big">Start free with a sandbox</Link>
            <a href="#how" className="lp-btn ghost big">See how it works</a>
          </div>
          <p className="lp-fine">No card required · Sandbox is free forever</p>
        </div>

        <div className="lp-demo" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <div className="lp-demo-bar">
            <span className="lp-search-ico">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            </span>
            <span className="lp-typed" key={`q${active}`}>{demo.q}</span>
            <span className="lp-caret" />
          </div>

          <div className="lp-chips" key={`c${active}`}>
            {demo.chips.map((c) => <span className="lp-chip" key={c}>{c}</span>)}
          </div>

          <div className="lp-grid" key={`g${active}`}>
            {demo.tiles.map((t, i) => (
              <div className="lp-tile" key={t.n} style={{ animationDelay: `${i * 55}ms` }}>
                <div className="lp-thumb" style={{ background:
                  `linear-gradient(135deg, hsl(${t.h} 55% 82%), hsl(${(t.h + 40) % 360} 50% 70%))` }} />
                <div className="lp-tile-n">{t.n}</div>
                <div className="lp-tile-p">{t.p}</div>
              </div>
            ))}
          </div>

          <div className="lp-dots">
            {DEMOS.map((d, i) => (
              <button key={d.q} aria-label={d.q}
                className={i === active ? 'on' : ''} onClick={() => { setActive(i); setPaused(true); }} />
            ))}
          </div>
        </div>
      </section>

      <section className="lp-logos">
        <span>Renders through</span>
        <strong>Salesforce B2C Commerce (SFRA)</strong>
        <span className="lp-sep">·</span>
        <strong>Shopify</strong>
        <span className="lp-sep">·</span>
        <span>your templates, unchanged</span>
      </section>

      <section id="benefits" className="lp-section">
        <h2 className="lp-h2">What you can achieve</h2>
        <p className="lp-sub">Everything a merchandiser wishes site search did — without a redesign.</p>
        <div className="lp-benefits">
          {BENEFITS.map((b) => (
            <div className="lp-benefit" key={b.t}>
              <span className="lp-benefit-ico"><Icon name={b.icon} /></span>
              <h3>{b.t}</h3>
              <p>{b.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-idea">
        <div className="lp-idea-inner">
          <h2 className="lp-h2">The gateway returns IDs — never prices</h2>
          <p>
            The correct price is a function of price book, customer group, active
            promotions and locale tax. Two shoppers hitting the same page at the
            same second can legitimately see different prices. So Algivo decides
            <strong> what is relevant</strong>; your storefront decides
            <strong> what is true</strong> and renders it in the shopper’s session.
          </p>
          <div className="lp-flow">
            <div className="lp-flow-step"><span>1</span>Shopper query</div>
            <div className="lp-flow-arrow">→</div>
            <div className="lp-flow-step"><span>2</span>Intent parsed to your taxonomy</div>
            <div className="lp-flow-arrow">→</div>
            <div className="lp-flow-step"><span>3</span>Hybrid retrieval, ranked IDs</div>
            <div className="lp-flow-arrow">→</div>
            <div className="lp-flow-step"><span>4</span>Your PLP renders live price &amp; stock</div>
          </div>
        </div>
      </section>

      <section id="how" className="lp-section">
        <h2 className="lp-h2">Live in three steps</h2>
        <div className="lp-how">
          <div className="lp-how-step">
            <span className="lp-step-n">1</span>
            <h3>Install</h3>
            <p>Drop in the cartridge or install the Shopify app. Auto-discovery reads your catalog and attribute taxonomy for you.</p>
          </div>
          <div className="lp-how-step">
            <span className="lp-step-n">2</span>
            <h3>Sync</h3>
            <p>Your catalog uploads over SFTP and is embedded in the background. Prices and stock never leave your instance.</p>
          </div>
          <div className="lp-how-step">
            <span className="lp-step-n">3</span>
            <h3>Go live</h3>
            <p>Results render through your existing tiles behind a URL token. Turn it on or off from a single preference.</p>
          </div>
        </div>
      </section>

      <section id="pricing" className="lp-section lp-pricing">
        <h2 className="lp-h2">Simple, usage-aligned pricing</h2>
        <p className="lp-sub">Per month, plus GST. Sandbox and UAT are never billed.</p>

        <div className="lp-free">
          <div>
            <h3>Free sandbox</h3>
            <p className="lp-sub">Full console, real keys, discovery and search against a sandbox. No card, forever.</p>
          </div>
          <Link to="/signup" className="lp-btn">Start free</Link>
        </div>

        <div className="lp-plans">
          {PLANS.map((p) => (
            <div className={`lp-plan ${p.featured ? 'featured' : ''}`} key={p.id}>
              {p.featured && <span className="lp-plan-tag">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="lp-price">{p.price}{p.price !== 'Custom' && <span>/mo</span>}</div>
              <p className="lp-sub">{p.queries} production queries included</p>
              <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              <button type="button" onClick={() => pickPlan(p.name)}
                      className={`lp-btn ${p.featured ? '' : 'ghost'} full`}>
                Contact sales
              </button>
            </div>
          ))}
        </div>
        <p className="lp-fine center">
          Annual and volume pricing available. Queries that fall back to native
          search are never charged.
        </p>
      </section>

      <section id="contact" className="lp-section lp-contact">
        <h2 className="lp-h2">Talk to us</h2>
        <p className="lp-sub">
          Tell us about your store and we’ll set you up with the right plan.
          Prefer email? <a href="mailto:sales@thinkvisor.io">sales@thinkvisor.io</a>.
        </p>
        {sent ? (
          <div className="lp-contact-done">
            <strong>Thanks — we’ve got your details.</strong>
            <p className="lp-sub">Our team will be in touch shortly.</p>
          </div>
        ) : (
          <form className="lp-contact-form" onSubmit={submitContact}>
            <div className="lp-field-row">
              <label>Name<input type="text" value={form.name} onChange={setField('name')} /></label>
              <label>Work email<input type="email" required value={form.email} onChange={setField('email')} /></label>
            </div>
            <div className="lp-field-row">
              <label>Company<input type="text" value={form.company} onChange={setField('company')} /></label>
              <label>Plan
                <select value={form.plan} onChange={setField('plan')}>
                  <option value="">Not sure yet</option>
                  {PLANS.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </label>
            </div>
            <label>Anything else?
              <textarea rows="3" value={form.message} onChange={setField('message')}
                        placeholder="Platform (SFCC / Shopify), catalog size, timeline…" />
            </label>
            {err && <p className="error">{err}</p>}
            <button type="submit" className="lp-btn big" disabled={sending}>
              {sending ? 'Sending…' : 'Request a call'}
            </button>
          </form>
        )}
      </section>

      <section className="lp-final">
        <h2>Ready to see it on your catalog?</h2>
        <p>Spin up a free sandbox and run discovery in minutes.</p>
        <Link to="/signup" className="lp-btn big light">Start free</Link>
      </section>

      <footer className="lp-foot">
        <Logo size={22} />
        <div className="lp-foot-links">
          <a href="#benefits">Benefits</a>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Sign in</Link>
          <a href="mailto:sales@thinkvisor.io">sales@thinkvisor.io</a>
        </div>
        <span className="lp-fine">© 2026 Algivo · thinkvisor.io</span>
      </footer>
    </div>
  );
}
