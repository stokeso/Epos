/**
 * Trading periods: open, X read, Z close (spec §6.11, §7; D-040..D-047, D-061, D-067, D-068).
 */
import { AppError } from '../data/errors';
import type { Period } from '../data/types';
import { renderXReport, renderZReport } from '../receipt';
import { isBasketEmpty, type BasketState } from '../rules/basket';
import { periodFigures, zFigures, type PeriodFigures, type ZFigures } from '../rules/cashup';
import { validateCashAmount } from '../rules/validation';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { getSettings } from './settings';
import { describeError, fallbackDocument, validationError } from './shared';

const NO_OPEN_PERIOD_MESSAGE = 'No trading period open';
const BASKET_NOT_EMPTY_MESSAGE = 'Finish, park or void the current basket first';

/** The device's open period, if any. */
export function getOpenPeriod(ctx: ServiceContext): Promise<Period | undefined> {
  return ctx.repos.periods.getOpen();
}

/** getOpenPeriod or throw AppError('NO_OPEN_PERIOD', 'No trading period open') (D-068). */
export async function requireOpenPeriod(ctx: ServiceContext): Promise<Period> {
  const period = await getOpenPeriod(ctx);
  if (period === undefined) throw new AppError('NO_OPEN_PERIOD', NO_OPEN_PERIOD_MESSAGE);
  return period;
}

function assertCashAmount(pence: number, field: 'floatPence' | 'declaredCashPence', label: string): void {
  if (!validateCashAmount(pence)) throw validationError({ [field]: `${label} must be £0.00 to £99,999.99` });
}

/**
 * Opens a period (D-067). auth.action 'openClosePeriod'; floatPence integer 0..MAX_KEYPAD_PENCE.
 * transact: periods.open({ openedBy: auth.staffId, floatPence }) + overrideEvents(auth, newPeriod.id).
 */
export async function openPeriod(ctx: ServiceContext, auth: Authorisation, floatPence: number): Promise<Period> {
  assertAuthorised(auth, 'openClosePeriod');
  assertCashAmount(floatPence, 'floatPence', 'The float');
  return ctx.repos.transact(async () => {
    const period = await ctx.repos.periods.open({ openedBy: auth.staffId, floatPence });
    await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
    return period;
  });
}

/** The period's figures from its stored sales and audit events (D-040, D-041). */
async function figuresFor(ctx: ServiceContext, period: Period): Promise<PeriodFigures> {
  const sales = await ctx.repos.sales.listByPeriod(period.id);
  const auditEvents = await ctx.repos.auditEvents.listByPeriod(period.id);
  return periodFigures({ period, sales, auditEvents });
}

/** Figures for the open period as of now (reads sales/audit by periodId; D-040, D-041). */
export async function currentPeriodFigures(ctx: ServiceContext): Promise<{ period: Period; figures: PeriodFigures }> {
  const period = await requireOpenPeriod(ctx);
  return { period, figures: await figuresFor(ctx, period) };
}

async function staffName(ctx: ServiceContext, staffId: string): Promise<string> {
  return (await ctx.repos.staff.get(staffId))?.name ?? 'Unknown';
}

export interface XReadResult {
  period: Period;
  figures: PeriodFigures;
  /** renderXReport HTML. */
  document: string;
}

/**
 * X read (D-046). auth.action 'xRead'; needs an open period. Writes nothing except the override
 * audit event when overridden (written once the document has been produced, D-072).
 */
export async function runXRead(ctx: ServiceContext, auth: Authorisation): Promise<XReadResult> {
  assertAuthorised(auth, 'xRead');
  const printedAt = nowIso(ctx);
  const { period, figures } = await currentPeriodFigures(ctx);
  const settings = await getSettings(ctx);
  const document = renderXReport({
    kind: 'X',
    clubName: settings.clubName,
    printedAt,
    printedByName: await staffName(ctx, auth.staffId),
    openedAt: period.openedAt,
    openedByName: await staffName(ctx, period.openedBy),
    figures,
  });
  await ctx.repos.auditEvents.append(overrideEvents(auth, period.id));
  return { period, figures, document };
}

export interface ZClosePrecheck {
  period: Period;
  /** Open, non-deleted tabs that will carry over (warn when > 0). */
  openTabCount: number;
}

function assertBasketEmpty(basket: BasketState): void {
  if (!isBasketEmpty(basket)) throw new AppError('BASKET_NOT_EMPTY', BASKET_NOT_EMPTY_MESSAGE);
}

/**
 * Z close step 1 (D-047): needs an open period and an empty basket (isBasketEmpty), else
 * AppError('BASKET_NOT_EMPTY', 'Finish, park or void the current basket first').
 */
export async function prepareZClose(ctx: ServiceContext, basket: BasketState): Promise<ZClosePrecheck> {
  const period = await requireOpenPeriod(ctx);
  assertBasketEmpty(basket);
  const openTabs = await ctx.repos.tabs.listOpen();
  return { period, openTabCount: openTabs.length };
}

export interface ZClosePreview {
  expectedCashPence: number;
  declaredCashPence: number;
  /** declared - expected. */
  variancePence: number;
}

/** Z close step 3: computes expected cash and variance for the declared amount (writes nothing). */
export async function previewZClose(ctx: ServiceContext, declaredCashPence: number): Promise<ZClosePreview> {
  assertCashAmount(declaredCashPence, 'declaredCashPence', 'The counted cash');
  const { figures } = await currentPeriodFigures(ctx);
  const z = zFigures(figures, declaredCashPence);
  return { expectedCashPence: z.expectedCashPence, declaredCashPence: z.declaredCashPence, variancePence: z.variancePence };
}

export interface ZCloseResult {
  period: Period;
  figures: ZFigures;
  /** renderZReport HTML. */
  document: string;
}

/**
 * Z close step 4 (D-047). auth.action 'openClosePeriod'; basket must be empty. In ONE transaction:
 * reads the period's sales and audit events, computes zFigures, periods.close(...) (assigns
 * zNumber) and appends [...overrideEvents, zClose { zNumber, floatPence, expectedCashPence,
 * declaredCashPence, variancePence }] with periodId = the closed period. Then renders the Z
 * document; the close has committed by then, so a rendering failure yields a fallback document
 * rather than a throw.
 */
export async function confirmZClose(
  ctx: ServiceContext,
  auth: Authorisation,
  basket: BasketState,
  declaredCashPence: number,
): Promise<ZCloseResult> {
  assertAuthorised(auth, 'openClosePeriod');
  assertCashAmount(declaredCashPence, 'declaredCashPence', 'The counted cash');
  assertBasketEmpty(basket);

  const { period, figures } = await ctx.repos.transact(async () => {
    const open = await requireOpenPeriod(ctx);
    const z = zFigures(await figuresFor(ctx, open), declaredCashPence);
    const closed = await ctx.repos.periods.close({ periodId: open.id, closedBy: auth.staffId, declaredCashPence });
    const zNumber = closed.zNumber;
    if (zNumber === undefined) throw new AppError('CONFLICT', 'The period closed without a Z number');
    await ctx.repos.auditEvents.append([
      ...overrideEvents(auth, closed.id),
      {
        type: 'zClose',
        ...auditActor(auth),
        periodId: closed.id,
        detail: {
          zNumber,
          floatPence: z.floatPence,
          expectedCashPence: z.expectedCashPence,
          declaredCashPence: z.declaredCashPence,
          variancePence: z.variancePence,
        },
      },
    ]);
    return { period: closed, figures: z };
  });

  const zNumber = period.zNumber ?? 0;
  let document: string;
  try {
    const settings = await getSettings(ctx);
    document = renderZReport({
      kind: 'Z',
      clubName: settings.clubName,
      zNumber,
      openedAt: period.openedAt,
      openedByName: await staffName(ctx, period.openedBy),
      closedAt: period.closedAt ?? period.updatedAt,
      closedByName: await staffName(ctx, period.closedBy ?? auth.staffId),
      figures,
    });
  } catch (error) {
    document = fallbackDocument(`Z report ${zNumber}`, `Z ${zNumber} was closed, but the report could not be printed.`, describeError(error));
  }
  return { period, figures, document };
}
