// Algivo brand mark. Self-contained SVG — a gradient tile (the product's PLP
// tile) with a spark (the AI merchandising signal). No external assets.
export function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="algivoGrad" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#3f3a8c" />
          <stop offset="1" stopColor="#6d63d6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#algivoGrad)" />
      {/* four-point spark */}
      <path d="M15.5 7c.7 4.1 2.2 5.6 6.3 6.3-4.1.7-5.6 2.2-6.3 6.3-.7-4.1-2.2-5.6-6.3-6.3 4.1-.7 5.6-2.2 6.3-6.3Z"
            fill="#fff" />
      <circle cx="22" cy="22" r="2.1" fill="#fff" fillOpacity=".9" />
    </svg>
  );
}

export default function Logo({ size = 28 }) {
  return (
    <span className="algivo-logo">
      <LogoMark size={size} />
      <span className="algivo-word">Algivo</span>
    </span>
  );
}
