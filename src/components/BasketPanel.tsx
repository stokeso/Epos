import type { ReactNode } from 'react';
import type { BasketState } from '../rules/basket';
import type { PricedLine } from '../rules/pricing';
import { formatLocalDate } from '../rules/time';
import { tabDisplayLabel } from '../rules/validation';
import { memberLabel } from '../services/members';
import type { BasketView } from '../services/till';
import { BasketLineRow } from './BasketLineRow';
import { keepFocusWhenRemoved } from './focus';
import { MoneyText } from './MoneyText';
import styles from './BasketPanel.module.css';

export interface BasketPanelProps {
  /** useBasketStore view (viewBasket result); null for an empty or not-yet-priced basket. */
  view: BasketView | null;
  /** useBasketStore basket (used while the first pricing is in flight). */
  basket: BasketState;
  /** settings.memberDiscountPercent, shown on the member discount row. */
  memberDiscountPercent?: number;
  selectedProductId?: string | null;
  /** Makes lines selectable (e.g. to void the selected line). */
  onSelectLine?: (productId: string) => void;
  /** Extra controls per line. */
  lineTrailing?: (line: PricedLine) => ReactNode;
  /** Shows a 'Remove member' button on the member badge. */
  onRemoveMember?: () => void;
  /** Shows a 'Remove booking' button on the booking badge. */
  onRemoveBooking?: () => void;
  /** useBasketStore pricing flag (sets aria-busy). */
  pricing?: boolean;
  /** Rendered under the total (e.g. the Pay button). */
  actions?: ReactNode;
  /** Default 'Basket'. */
  heading?: string;
  /** Hide the heading (e.g. inside a BottomSheet titled 'Basket'). */
  hideHeading?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * The basket (spec §6.3): lines, deal lines, member line, deposit line and the running total.
 * Pure display of BasketView: no pricing here. Stable test ids: basket-total, member-badge,
 * deposit-line.
 */
export function BasketPanel({
  view,
  basket,
  memberDiscountPercent,
  selectedProductId = null,
  onSelectLine,
  lineTrailing,
  onRemoveMember,
  onRemoveBooking,
  pricing = false,
  actions,
  heading = 'Basket',
  hideHeading = false,
  disabled = false,
  className,
}: BasketPanelProps) {
  const priced = view?.priced;
  const lines = priced?.lines ?? [];
  const unitCount = basket.lines.reduce((sum, line) => sum + line.qty, 0);
  const memberAttached = view?.member !== undefined;
  const tab = view?.tab;

  return (
    // tabIndex -1: when a focused control in the basket removes itself ('Remove member', '−' on a
    // line's last unit), focus moves to the basket rather than falling to <body> (D-135).
    <section className={`${styles.panel} ${className ?? ''}`} aria-label={hideHeading ? heading : undefined} aria-busy={pricing || undefined} tabIndex={-1}>
      {!hideHeading && (
        <div className={styles.head}>
          <h2 className={styles.heading}>{heading}</h2>
          <span className={styles.count}>
            {unitCount} {unitCount === 1 ? 'item' : 'items'}
          </span>
        </div>
      )}

      {(tab !== undefined || view?.member !== undefined || view?.booking !== undefined) && (
        <div className={styles.badges}>
          {tab !== undefined && (
            <div className={`${styles.badge} ${styles.badgeTab}`} data-testid="tab-badge">
              <span className={styles.badgeLabel}>Tab</span>
              <span className={styles.badgeValue}>{tabDisplayLabel(tab)}</span>
            </div>
          )}
          {view?.member !== undefined && (
            <div className={`${styles.badge} ${styles.badgeMember}`} data-testid="member-badge">
              <span className={styles.badgeLabel}>Member</span>
              <span className={styles.badgeValue}>{memberLabel(view.member)}</span>
              {onRemoveMember !== undefined && (
                <button
                  type="button"
                  className={styles.badgeRemove}
                  onClick={(event) => {
                    keepFocusWhenRemoved(event.currentTarget);
                    onRemoveMember();
                  }}
                  disabled={disabled}
                  aria-label="Remove member"
                >
                  <RemoveIcon />
                </button>
              )}
            </div>
          )}
          {view?.booking !== undefined && (
            <div className={`${styles.badge} ${styles.badgeBooking}`} data-testid="booking-badge">
              <span className={styles.badgeLabel}>Booking</span>
              <span className={styles.badgeValue}>
                {view.booking.name} · {formatLocalDate(view.booking.date)}
              </span>
              {onRemoveBooking !== undefined && (
                <button
                  type="button"
                  className={styles.badgeRemove}
                  onClick={(event) => {
                    keepFocusWhenRemoved(event.currentTarget);
                    onRemoveBooking();
                  }}
                  disabled={disabled}
                  aria-label="Remove booking"
                >
                  <RemoveIcon />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.scroll}>
        {lines.length === 0 ? (
          <p className={styles.empty}>{basket.lines.length === 0 ? 'No items yet. Tap a product to add it.' : 'Pricing…'}</p>
        ) : (
          <ul className={styles.lines} aria-label="Basket lines">
            {lines.map((line) => (
              <BasketLineRow
                key={line.productId}
                line={line}
                selected={selectedProductId === line.productId}
                onSelect={onSelectLine}
                trailing={lineTrailing?.(line)}
                disabled={disabled}
              />
            ))}
          </ul>
        )}

        {priced !== undefined && (priced.dealLines.length > 0 || memberAttached || priced.depositAppliedPence > 0) && (
          <ul className={styles.adjustments} aria-label="Discounts and deposits">
            {priced.dealLines.map((deal) => (
              <li key={deal.dealId} className={styles.adjustment} data-testid="deal-line">
                <span>
                  {deal.name}
                  {deal.groupCount > 1 ? ` x${deal.groupCount}` : ''}
                </span>
                <MoneyText pence={deal.savingPence} asDeduction />
              </li>
            ))}
            {memberAttached && (
              <li className={styles.adjustment} data-testid="member-discount-line">
                <span>Member discount{memberDiscountPercent === undefined ? '' : ` (${memberDiscountPercent}%)`}</span>
                <MoneyText pence={priced.memberDiscountPence} asDeduction />
              </li>
            )}
            {priced.depositAppliedPence > 0 && (
              <li className={styles.adjustment} data-testid="deposit-line">
                <span>Deposit taken</span>
                <MoneyText pence={priced.depositAppliedPence} asDeduction />
              </li>
            )}
          </ul>
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Total</span>
          <MoneyText pence={priced?.totalPence ?? 0} size="2xl" strong testId="basket-total" />
        </div>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      </div>
    </section>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
