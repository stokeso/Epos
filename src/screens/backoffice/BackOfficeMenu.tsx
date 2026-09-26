/**
 * Back office home (spec §6.9; architecture §7.1): one link per section. Navigation is never
 * permission-gated (D-070); saving inside a section asks for a manager PIN when needed.
 * Members and Bookings live at #/members and #/bookings.
 */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Screen } from '../../components/Screen';
import { useLoad } from '../../app/useLoad';
import { formatDateTime } from '../../rules/time';
import { listLowStock } from '../../services/stock';
import { useAppStore } from '../../store/appStore';
import { PermissionNote } from './parts';
import styles from './BackOfficeMenu.module.css';

interface Section {
  to: string;
  title: string;
  description: string;
  icon: ReactNode;
  /** Live status line (e.g. low-stock count). */
  status?: ReactNode;
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS = {
  products: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path {...stroke} d="M10 2.5h4M10.5 2.5v3.2L8 9.5v11a1 1 0 001 1h6a1 1 0 001-1v-11l-2.5-3.8V2.5" />
      <path {...stroke} d="M8 13h8v4H8z" />
    </svg>
  ),
  categories: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <rect {...stroke} x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  ),
  deals: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path {...stroke} d="M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.4 1.4 0 010 2l-6.7 6.7a1.4 1.4 0 01-2 0z" />
      <circle {...stroke} cx="8" cy="8" r="1.4" />
      <path {...stroke} d="M9.5 15.5l5-5" />
    </svg>
  ),
  staff: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <circle {...stroke} cx="9" cy="8" r="3.5" />
      <path {...stroke} d="M2.5 20a6.5 6.5 0 0113 0" />
      <path {...stroke} d="M16 4.8a3.5 3.5 0 010 6.4M18 14a6.5 6.5 0 013.5 6" />
    </svg>
  ),
  stock: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path {...stroke} d="M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z" />
      <path {...stroke} d="M3.5 7.5L12 12l8.5-4.5M12 12v9" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <circle {...stroke} cx="12" cy="12" r="3" />
      <path
        {...stroke}
        d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"
      />
    </svg>
  ),
  backup: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path {...stroke} d="M4 15.5V19a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 19v-3.5" />
      <path {...stroke} d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
    </svg>
  ),
  members: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <rect {...stroke} x="2.5" y="5" width="19" height="14" rx="2" />
      <circle {...stroke} cx="8.5" cy="11" r="2.2" />
      <path {...stroke} d="M5 16.2a3.8 3.8 0 017 0M14.5 10h4M14.5 13.5h3" />
    </svg>
  ),
  bookings: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <rect {...stroke} x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path {...stroke} d="M3.5 9.5h17M8 3v4M16 3v4M8 13.5h2M14 13.5h2M8 17h2" />
    </svg>
  ),
} as const;

function lowStockStatus(count: number | undefined): ReactNode {
  if (count === undefined) return undefined;
  if (count === 0) return <span className={styles.statusOk}>Nothing low on stock</span>;
  return <span className={styles.statusWarn}>{count === 1 ? '1 item low on stock' : `${count} items low on stock`}</span>;
}

export function BackOfficeMenu() {
  const lowStock = useLoad(listLowStock, []);
  const lastBackupAt = useAppStore((s) => s.settings?.lastBackupAt);

  const groups: { heading: string; sections: Section[] }[] = [
    {
      heading: 'Catalogue',
      sections: [
        { to: '/backoffice/products', title: 'Products', description: 'Prices, VAT, till buttons and stock settings', icon: ICONS.products },
        { to: '/backoffice/categories', title: 'Categories', description: 'Till tabs, their order and colours', icon: ICONS.categories },
        { to: '/backoffice/deals', title: 'Deals', description: 'Multi-buys such as 2 for £8 or 3 for 2', icon: ICONS.deals },
      ],
    },
    {
      heading: 'Stock, members and bookings',
      sections: [
        {
          to: '/backoffice/stock',
          title: 'Stock',
          description: 'Levels, goods in, adjustments and waste',
          icon: ICONS.stock,
          status: lowStockStatus(lowStock.data?.length),
        },
        { to: '/members', title: 'Members', description: 'Find, add and edit club members', icon: ICONS.members },
        { to: '/bookings', title: 'Bookings', description: 'Weddings, society days and deposits', icon: ICONS.bookings },
      ],
    },
    {
      heading: 'Staff and this till',
      sections: [
        { to: '/backoffice/staff', title: 'Staff', description: 'Till users, roles and PINs', icon: ICONS.staff },
        { to: '/backoffice/settings', title: 'Settings', description: 'Club name, receipts, auto-lock and discount', icon: ICONS.settings },
        {
          to: '/backoffice/backup',
          title: 'Backup',
          description: 'Export a backup file or restore one',
          icon: ICONS.backup,
          status:
            lastBackupAt === undefined ? (
              <span className={styles.statusWarn}>Never backed up</span>
            ) : (
              <span className={styles.statusMuted}>Last backup {formatDateTime(lastBackupAt)}</span>
            ),
        },
      ],
    },
  ];

  return (
    <Screen title="Back office" description="Manage the catalogue, stock, people and this till.">
      <PermissionNote action="editCatalogue">Anyone can look around the back office. Saving a change needs a manager PIN.</PermissionNote>
      <nav aria-label="Back office sections" className={styles.groups}>
        {groups.map((group) => (
          <section key={group.heading} className={styles.group} aria-label={group.heading}>
            <h2 className={styles.groupHeading}>{group.heading}</h2>
            <ul className={styles.cards}>
              {group.sections.map((section) => (
                <li key={section.to}>
                  <SectionCard section={section} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </Screen>
  );
}

function SectionCard({ section }: { section: Section }) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Link to={section.to} className={styles.card} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <span className={styles.icon}>{section.icon}</span>
      <span className={styles.text}>
        <span id={titleId} className={styles.title}>
          {section.title}
        </span>
        <span id={descriptionId} className={styles.description}>
          {section.description}
          {section.status !== undefined && (
            <>
              <span className="visually-hidden">. </span>
              <span className={styles.status}>{section.status}</span>
            </>
          )}
        </span>
      </span>
      <svg className={styles.chevron} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}
