/**
 * The logged-in app shell: header (club name, period status, staff name, Menu, Lock), the
 * in-flow manager banners, and the routed screen in <main>.
 * The header owns the only 'Menu' and 'Lock' buttons: screens must not add their own.
 */
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { formatDateTime } from '../rules/time';
import { useAppStore } from '../store/appStore';
import { useSession } from '../store/sessionStore';
import { lock } from './auth';
import { Banners } from './Banners';
import { NAV_GROUPS, ROLE_LABELS } from './labels';
import styles from './AppShell.module.css';

export function AppShell() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // <main> is the one scroll container and stays mounted across routes: each screen opens at the
  // top, not at the last screen's offset (e.g. Pay's amount due scrolled out of view on a phone).
  useLayoutEffect(() => {
    if (mainRef.current !== null) mainRef.current.scrollTop = 0;
  }, [pathname]);
  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <AppHeader />
      <Banners />
      <main ref={mainRef} id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

/** Hash routing owns the URL fragment, so the skip link focuses <main> by hand. */
function skipToMain(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  document.getElementById('main')?.focus();
}

function AppHeader() {
  const session = useSession();
  const clubName = useAppStore((s) => s.settings?.clubName ?? 'Club EPOS');
  const [menuOpen, setMenuOpen] = useState(false);
  if (session === null) return null;
  return (
    <header className={styles.header}>
      <Link to="/till" className={styles.brand} aria-label={clubName}>
        <LogoMark />
        <span className={styles.clubName}>{clubName}</span>
      </Link>
      <PeriodStatus />
      <div className={styles.headerSpacer} />
      <div className={styles.staff}>
        <span className={styles.staffName} data-testid="current-staff">
          {session.name}
        </span>
        <span className={styles.staffRole}>{ROLE_LABELS[session.role]}</span>
      </div>
      <Button variant="onBrand" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-expanded={menuOpen} className={styles.headerButton}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <span className={styles.buttonText}>Menu</span>
      </Button>
      <Button variant="onBrand" onClick={lock} className={styles.headerButton}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 10.5V8a4 4 0 018 0v2.5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className={styles.buttonText}>Lock</span>
      </Button>
      <NavMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  );
}

function PeriodStatus() {
  const period = useAppStore((s) => s.openPeriod);
  const open = period !== null;
  return (
    <span
      className={`${styles.period} ${open ? styles.periodOpen : styles.periodClosed}`}
      data-testid="period-status"
      title={open ? `Opened ${formatDateTime(period.openedAt)}` : 'No period open'}
    >
      <span className={styles.periodDot} aria-hidden="true" />
      <span className={styles.periodText}>{open ? 'Period open' : 'No period open'}</span>
    </span>
  );
}

function NavMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSession();
  const clubName = useAppStore((s) => s.settings?.clubName ?? 'Club EPOS');
  return (
    <Modal open={open} onClose={onClose} title="Menu" placement="right" showCloseButton testId="nav-menu">
      <nav aria-label="Main" className={styles.nav}>
        {session !== null && (
          <div className={styles.navWho}>
            <span className={styles.navClub}>{clubName}</span>
            <span>
              Signed in as <strong>{session.name}</strong> ({ROLE_LABELS[session.role]})
            </span>
          </div>
        )}
        {NAV_GROUPS.map((group) => (
          <div key={group.heading ?? 'main'} className={styles.navGroup}>
            {group.heading !== null && <h3 className={styles.navHeading}>{group.heading}</h3>}
            <ul className={styles.navList}>
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} className={styles.navLink} onClick={onClose} end={item.to === '/backoffice' ? false : undefined}>
                    {item.label}
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </Modal>
  );
}

/** A small flag-on-the-green mark (inline SVG: no external assets). */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={styles.logo}>
      <circle cx="16" cy="16" r="15" fill="#ffffff" fillOpacity="0.14" stroke="#ffffff" strokeOpacity="0.5" />
      <ellipse cx="16" cy="24" rx="9" ry="3" fill="#86efac" fillOpacity="0.9" />
      <path d="M13 24V7" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
      <path d="M13.5 7.5l9 3.5-9 3.5z" fill="#fcd34d" />
    </svg>
  );
}
