/**
 * Open tabs (spec §6.6; D-062..D-066; architecture §5.4; docs/ui-plan.md §7).
 *
 * Every open tab with its label ('Smith' / 'Table 5'), its total repriced now (D-062), the time it
 * has been open, its item count and its member. All figures are services/tabs.listOpenTabs.
 * - Load: requirePermission('tabs') -> loadTab (the basket must be empty) -> basket.load -> #/till.
 * - Settle: the same load, then payStore.openSale() -> #/pay. The tab's member stays attached.
 * - The tab already on the till ('On till') offers 'Go to till' and Settle (straight to Pay).
 * Viewing needs no open period; Load and Settle do (D-068).
 */
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorCode, errorMessage, OpenPeriodDialog, requirePermission, useLoad } from '../../app';
import { Banner, Button, ButtonLink, MoneyText, Screen } from '../../components';
import type { Member } from '../../data/types';
import { isBasketEmpty } from '../../rules/basket';
import { sumPence } from '../../rules/money';
import { formatDateTime } from '../../rules/time';
import { listMembers, memberLabel } from '../../services/members';
import { loadTab, listOpenTabs, type TabSummary } from '../../services/tabs';
import { basketUnitCount, getCtx, toast, useAppStore, useBasketStore, useHasOpenPeriod, usePayStore } from '../../store';
import styles from './TabsScreen.module.css';

/** Time open is computed by the service at load time: refresh it every minute. */
const REFRESH_MS = 60_000;

type Busy = { tabId: string; kind: 'load' | 'settle' } | null;

export function TabsScreen() {
  const navigate = useNavigate();
  const basket = useBasketStore((s) => s.basket);
  const paySession = usePayStore((s) => s.session);
  const hasPeriod = useHasOpenPeriod();
  const tabs = useLoad((ctx) => listOpenTabs(ctx, basket), [basket.tabId]);
  const members = useLoad(listMembers, []);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodDialog, setPeriodDialog] = useState(false);
  const { reload } = tabs;

  useEffect(() => {
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const memberById = new Map<string, Member>((members.data ?? []).map((m) => [m.id, m]));
  const summaries = tabs.data;
  const basketEmpty = isBasketEmpty(basket);
  const inTabMode = basket.tabId !== undefined;
  const paymentInProgress = paySession !== null && paySession.tender.tenders.length > 0;
  const canLoadOthers = hasPeriod && basketEmpty && !paymentInProgress && busy === null;

  const fail = (caught: unknown, prefix?: string): void => {
    const code = errorCode(caught);
    if (code === 'NO_OPEN_PERIOD') void useAppStore.getState().refreshPeriod();
    setError(prefix === undefined ? errorMessage(caught) : `${prefix} ${errorMessage(caught)}`);
    if (code === 'TAB_NOT_OPEN' || code === 'BASKET_NOT_EMPTY') reload();
  };

  /** Load (reopen) a tab into the empty basket (D-063 c). Returns true when it is on the till. */
  const putOnTill = async (summary: TabSummary): Promise<boolean> => {
    const auth = await requirePermission('tabs');
    if (auth === null) return false;
    const next = await loadTab(getCtx(), auth, useBasketStore.getState().basket, summary.tab.id);
    await useBasketStore.getState().load(next);
    return true;
  };

  const load = async (summary: TabSummary): Promise<void> => {
    if (busy !== null) return;
    setError(null);
    setBusy({ tabId: summary.tab.id, kind: 'load' });
    try {
      if (await putOnTill(summary)) {
        toast(`Tab ${summary.displayLabel} is on the till`, { tone: 'success' });
        navigate('/till');
        return;
      }
    } catch (caught) {
      fail(caught);
    }
    setBusy(null);
  };

  const settle = async (summary: TabSummary): Promise<void> => {
    if (busy !== null) return;
    setError(null);
    setBusy({ tabId: summary.tab.id, kind: 'settle' });
    let loaded = summary.onTill;
    try {
      if (!loaded) loaded = await putOnTill(summary);
      if (loaded) {
        await usePayStore.getState().openSale();
        navigate('/pay');
        return;
      }
    } catch (caught) {
      // Already on the till but Pay refused (e.g. an item was deleted): say so, the till shows it.
      fail(caught, loaded && !summary.onTill ? `Tab ${summary.displayLabel} is on the till, but Pay could not open:` : undefined);
    }
    setBusy(null);
  };

  const totalOnTabs = summaries === undefined ? 0 : sumPence(summaries.map((s) => s.totalPence));

  return (
    <Screen
      title="Tabs"
      description="Open tabs, repriced now. Load a tab to add more, or settle it to take payment."
      actions={
        <ButtonLink to="/till" variant="secondary">
          Back to till
        </ButtonLink>
      }
    >
      {tabs.error !== null && <Banner tone="danger">{tabs.error}</Banner>}
      {error !== null && (
        <Banner tone="danger" onDismiss={() => setError(null)} testId="tabs-error">
          {error}
        </Banner>
      )}

      {summaries !== undefined && summaries.length > 0 && (
        <>
          {!hasPeriod ? (
            <Banner
              tone="warning"
              role="none"
              action={
                <Button size="sm" onClick={() => setPeriodDialog(true)}>
                  Open period
                </Button>
              }
            >
              No trading period open. Tabs can be viewed, but loading or settling one needs an open period.
            </Banner>
          ) : paymentInProgress ? (
            <Banner tone="warning" role="none" action={<ButtonLink to="/pay" size="sm">Back to Pay</ButtonLink>}>
              A payment is in progress. Finish or cancel it before loading another tab.
            </Banner>
          ) : !basketEmpty ? (
            <Banner tone="info" role="none" action={<ButtonLink to="/till" size="sm">Go to till</ButtonLink>} testId="tabs-basket-busy">
              {inTabMode
                ? 'A tab is on the till. Save it back to its tab or settle it before loading another.'
                : 'The till has a basket in progress. Finish it, move it to a tab or void it before loading a tab.'}
            </Banner>
          ) : null}
        </>
      )}

      {summaries === undefined && tabs.error === null && <p className={styles.muted}>Loading tabs…</p>}

      {summaries !== undefined && summaries.length === 0 && (
        <div className={styles.empty} data-testid="tabs-empty">
          <TabsIcon />
          <h2 className={styles.emptyTitle}>No open tabs</h2>
          <p className={styles.muted}>Open a tab from the till: add items, press Tab, then choose a name or a table.</p>
          <ButtonLink to="/till" variant="primary">
            Go to till
          </ButtonLink>
        </div>
      )}

      {summaries !== undefined && summaries.length > 0 && (
        <>
          <p className={styles.summary} data-testid="tabs-summary">
            <span>
              <strong>{summaries.length}</strong> open {summaries.length === 1 ? 'tab' : 'tabs'}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <MoneyText pence={totalOnTabs} strong testId="tabs-summary-total" /> on tabs
            </span>
          </p>
          <ul className={styles.grid} aria-label="Open tabs">
            {summaries.map((summary) => (
              <li key={summary.tab.id} className={styles.cell}>
                <TabCard
                  summary={summary}
                  member={summary.tab.memberId === undefined ? undefined : (memberById.get(summary.tab.memberId) ?? null)}
                  busy={busy}
                  canLoad={canLoadOthers}
                  canSettleOnTill={hasPeriod && !paymentInProgress && busy === null}
                  onLoad={() => void load(summary)}
                  onSettle={() => void settle(summary)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <OpenPeriodDialog open={periodDialog} onClose={() => setPeriodDialog(false)} />
    </Screen>
  );
}

function TabCard({
  summary,
  member,
  busy,
  canLoad,
  canSettleOnTill,
  onLoad,
  onSettle,
}: {
  summary: TabSummary;
  /** undefined: no member; null: a member id whose record isn't loaded (yet). */
  member: Member | null | undefined;
  busy: Busy;
  canLoad: boolean;
  canSettleOnTill: boolean;
  onLoad: () => void;
  onSettle: () => void;
}) {
  const headingId = useId();
  const metaId = useId();
  const { tab, displayLabel, onTill } = summary;
  const items = basketUnitCount({ lines: tab.lines });
  const mine = busy?.tabId === tab.id;
  const isTable = tab.labelType === 'table';
  return (
    <article className={`${styles.card} ${onTill ? styles.cardOnTill : ''}`} aria-labelledby={headingId} data-testid="tab-row">
      <div className={styles.cardTop}>
        <span className={`${styles.kind} ${isTable ? styles.kindTable : ''}`} aria-hidden="true">
          {isTable ? <TableIcon /> : <PersonIcon />}
        </span>
        <div className={styles.cardHeading}>
          <h2 id={headingId} className={styles.label}>
            {displayLabel}
          </h2>
          <p id={metaId} className={styles.meta}>
            <span data-testid="tab-time-open">Open {summary.timeOpen}</span>
            <span aria-hidden="true">·</span>
            <span>
              {items} {items === 1 ? 'item' : 'items'}
            </span>
          </p>
          <p className={styles.since}>Since {formatDateTime(summary.openedAt)}</p>
        </div>
      </div>

      <div className={styles.totalRow}>
        <div className={styles.tags}>
          {onTill && (
            <span className={`${styles.tag} ${styles.tagOnTill}`} data-testid="tab-on-till">
              On till
            </span>
          )}
          {member !== undefined && (
            <span className={`${styles.tag} ${styles.tagMember}`} data-testid="tab-member">
              <MemberIcon />
              <span className={styles.tagText}>{member === null ? 'Member attached' : memberLabel(member)}</span>
            </span>
          )}
          {!onTill && member === undefined && <span className={styles.totalLabel}>Total</span>}
        </div>
        <MoneyText pence={summary.totalPence} size="xl" strong className={styles.total} testId="tab-total" />
      </div>

      <div className={styles.actions}>
        {onTill ? (
          <ButtonLink to="/till" variant="secondary" aria-label={`Go to till with ${displayLabel}`}>
            Go to till
          </ButtonLink>
        ) : (
          <Button
            variant="secondary"
            onClick={onLoad}
            disabled={!canLoad}
            busy={mine && busy?.kind === 'load'}
            aria-label={`Load ${displayLabel}`}
            aria-describedby={metaId}
          >
            Load
          </Button>
        )}
        <Button
          variant="primary"
          onClick={onSettle}
          disabled={onTill ? !canSettleOnTill : !canLoad}
          busy={mine && busy?.kind === 'settle'}
          aria-label={`Settle ${displayLabel}`}
          aria-describedby={metaId}
        >
          Settle
        </Button>
      </div>
    </article>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 20a7.5 7.5 0 0115 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M3 9h18M6 9v10M18 9v10M8 14h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 5h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MemberIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z" fill="currentColor" />
    </svg>
  );
}

function TabsIcon() {
  return (
    <svg className={styles.emptyIcon} viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
      <rect x="9" y="6" width="30" height="36" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path d="M16 16h16M16 23h16M16 30h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
