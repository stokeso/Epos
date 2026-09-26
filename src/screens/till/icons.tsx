/** Inline SVG icons for the till action bar (no external assets: the till works offline). */

const common = {
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function MemberIcon() {
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c.8-3.9 3.8-6 7.5-6s6.7 2.1 7.5 6" />
    </svg>
  );
}

export function TabIcon() {
  return (
    <svg {...common}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}

export function BookingIcon() {
  return (
    <svg {...common}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function VoidIcon() {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
    </svg>
  );
}

export function NoSaleIcon() {
  return (
    <svg {...common}>
      <rect x="3" y="11" width="18" height="9" rx="1.5" />
      <path d="M10 15.5h4M5 11l1.5-6h11L19 11" />
    </svg>
  );
}

export function MinusIcon() {
  return (
    <svg {...common} width={20} height={20} strokeWidth={2.6}>
      <path d="M6 12h12" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...common} width={20} height={20} strokeWidth={2.6}>
      <path d="M12 6v12M6 12h12" />
    </svg>
  );
}
