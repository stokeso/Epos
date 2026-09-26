/** Display labels shared by the shell and screens. */
import type { Role } from '../data/types';

export const ROLE_LABELS = {
  staff: 'Staff',
  supervisor: 'Supervisor',
  manager: 'Manager',
} as const satisfies Record<Role, string>;

export interface NavItem {
  to: string;
  label: string;
}

export interface NavGroup {
  /** Group heading (null for the top group). */
  heading: string | null;
  items: readonly NavItem[];
}

/** The navigation menu (D-070: never permission-gated; every role sees every entry). */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    heading: null,
    items: [
      { to: '/till', label: 'Till' },
      { to: '/tabs', label: 'Tabs' },
      { to: '/bookings', label: 'Bookings' },
      { to: '/members', label: 'Members' },
      { to: '/refunds', label: 'Refunds' },
      { to: '/period', label: 'Period' },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports/product-sales', label: 'Product sales report' },
      { to: '/reports/vat', label: 'VAT report' },
    ],
  },
  {
    heading: 'Manage',
    items: [{ to: '/backoffice', label: 'Back office' }],
  },
];
