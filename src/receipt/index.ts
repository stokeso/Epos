/**
 * Receipt and X/Z report documents (spec §6.10; D-107..D-110).
 *
 * Pure renderers: each takes a fully resolved model (names already looked up by
 * services/receipts.ts or services/periods.ts) and returns a COMPLETE HTML document string
 * ('<!doctype html>...'), 80 mm wide, monospace till-roll style, no scripts, with RECEIPT_CSP in
 * a <meta http-equiv="Content-Security-Policy">. Every interpolated value goes through
 * escapeHtml (D-110). Money is formatted with rules/money.formatPence; dates with
 * rules/time.formatDateTime (London, 'DD/MM/YYYY HH:mm').
 *
 * Layout conventions (stable, so tests and e2e can read documents):
 * - A money or figure row is `<div class="row"><span class="label">…</span> <span class="amount">…</span></div>`.
 *   The space between the spans keeps textContent readable ('TOTAL £9.77').
 * - Header facts are one `<p>` each, e.g. 'Receipt: 3F9C-000042', 'Served by: Sam Staff',
 *   'Tab: Table 5', 'Booking: Smith wedding', 'Refund of 3F9C-000041'.
 * - The VAT summary is `<table class="vat">` with columns Rate, Net, VAT, Gross.
 */
import type {
  BookingType,
  IsoInstant,
  LocalDate,
  Pence,
  SaleDealLine,
  SaleLine,
  Tender,
  TenderType,
} from '../data/types';
import { BOOKING_TYPE_LABELS } from '../rules/booking';
import type { PeriodFigures, ZFigures } from '../rules/cashup';
import { formatPence, mulDivRoundHalfUp, negate, sumPence } from '../rules/money';
import { formatDateTime, formatLocalDate } from '../rules/time';
import type { VatSummaryRow } from '../rules/vat';

/** CSP for every generated document (D-110). */
export const RECEIPT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** Deposit receipts print this instead of a VAT summary (D-024). */
export const DEPOSIT_VAT_NOTE = 'No VAT - deposit is a prepayment; VAT is charged on the final bill';

/** Header fields common to sale, deposit and refund receipts. */
export interface ReceiptHeader {
  clubName: string;
  /** Settings.receiptFooter; newlines become <br> after escaping. */
  footer: string;
  /** sale.createdAt */
  createdAt: IsoInstant;
  receiptNumber: string;
  /** Name of sale.staffId. */
  staffName: string;
}

export interface SaleReceiptModel extends ReceiptHeader {
  kind: 'sale';
  lines: readonly SaleLine[];
  dealLines: readonly SaleDealLine[];
  /** Present whenever a member is attached; the member line prints even at £0.00 (D-107). */
  memberNumber?: string;
  memberDiscountPence: Pence;
  depositAppliedPence: Pence;
  /** Optional context lines. */
  tabLabel?: string;
  bookingName?: string;
  totalPence: Pence;
  tenders: readonly Tender[];
  changePence: Pence;
  /** vatSummary(lines). */
  vatSummary: readonly VatSummaryRow[];
}

export interface RefundReceiptModel extends ReceiptHeader {
  kind: 'refund';
  originalReceiptNumber: string;
  /** Stored refund lines (negative). */
  lines: readonly SaleLine[];
  memberNumber?: string;
  /** <= 0 */
  memberDiscountPence: Pence;
  /** <= 0 */
  totalPence: Pence;
  tenders: readonly Tender[];
  /** vatSummary(lines) (negative figures). */
  vatSummary: readonly VatSummaryRow[];
}

export interface DepositReceiptModel extends ReceiptHeader {
  kind: 'deposit';
  booking: { name: string; type: BookingType; date: LocalDate };
  amountPence: Pence;
  tenders: readonly Tender[];
  changePence: Pence;
  /** Unused balance after this deposit ('Deposit balance now £X'). */
  balanceAfterPence: Pence;
}

export type ReceiptModel = SaleReceiptModel | RefundReceiptModel | DepositReceiptModel;

/** One signed amount in a receipt's items section (D-107). */
export interface ReceiptAmountRow {
  label: string;
  amountPence: Pence;
}

export interface XReportModel {
  kind: 'X';
  clubName: string;
  /** When the read was taken. */
  printedAt: IsoInstant;
  printedByName: string;
  openedAt: IsoInstant;
  openedByName: string;
  figures: PeriodFigures;
}

export interface ZReportModel {
  kind: 'Z';
  clubName: string;
  zNumber: number;
  openedAt: IsoInstant;
  openedByName: string;
  closedAt: IsoInstant;
  closedByName: string;
  figures: ZFigures;
}

// ---------------------------------------------------------------------------
// Escaping (D-110)
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes & < > " ' to entities (D-110). */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Escapes, then turns each newline (\n, \r\n or \r) into <br> (D-108, D-110). */
function escapeMultiline(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// Items section (D-107)
// ---------------------------------------------------------------------------

/** qty * unit as an exact integer (never -0, e.g. a refund of a £0.00 item). */
function lineGross(line: SaleLine): Pence {
  return mulDivRoundHalfUp(line.qty, line.unitPricePence, 1);
}

function lineRow(line: SaleLine): ReceiptAmountRow {
  return { label: `${line.qty} x ${line.nameAtSale} @ ${formatPence(line.unitPricePence)}`, amountPence: lineGross(line) };
}

/** '{name} x{groupCount}', with 'x1' omitted (D-017). */
function dealLineLabel(dealLine: SaleDealLine): string {
  return dealLine.groupCount === 1 ? dealLine.name : `${dealLine.name} x${dealLine.groupCount}`;
}

/**
 * 'Member discount (#n)' whenever a member is attached (even at £0.00, D-107). Should a
 * non-zero discount ever arrive without a member number, it still prints (unnumbered) so the
 * rows keep summing to TOTAL.
 */
function memberRows(memberNumber: string | undefined, memberDiscountPence: Pence): ReceiptAmountRow[] {
  const amountPence = negate(memberDiscountPence);
  if (memberNumber !== undefined) return [{ label: `Member discount (#${memberNumber})`, amountPence }];
  return memberDiscountPence === 0 ? [] : [{ label: 'Member discount', amountPence }];
}

/**
 * The signed items-section rows that sum to totalPence (D-107), in print order:
 * sale: each line '{qty} x {name} @ {unit}' = gross; each deal line '{name} x{groupCount}'
 * ('x1' omitted) = -saving; 'Member discount (#{n})' = -memberDiscount (whenever a member is
 * attached); 'Deposit applied' = -depositApplied (only if > 0).
 * refund: each line = qty * unit (negative); 'Deal discount' = negate(sum line deal) when
 * non-zero; 'Member discount (#{n})' = negate(memberDiscount) when a member is attached.
 * Example (sale S1): 1350 + 250 - 450 - 173 = 977.
 * Labels are plain text; the renderers escape them.
 */
export function itemRows(model: SaleReceiptModel | RefundReceiptModel): ReceiptAmountRow[] {
  const rows = model.lines.map(lineRow);
  if (model.kind === 'sale') {
    for (const dealLine of model.dealLines) {
      rows.push({ label: dealLineLabel(dealLine), amountPence: negate(dealLine.savingPence) });
    }
    rows.push(...memberRows(model.memberNumber, model.memberDiscountPence));
    if (model.depositAppliedPence > 0) {
      rows.push({ label: 'Deposit applied', amountPence: negate(model.depositAppliedPence) });
    }
    return rows;
  }
  const dealDiscountPence = sumPence(model.lines.map((line) => line.dealDiscountPence));
  if (dealDiscountPence !== 0) rows.push({ label: 'Deal discount', amountPence: negate(dealDiscountPence) });
  rows.push(...memberRows(model.memberNumber, model.memberDiscountPence));
  return rows;
}

// ---------------------------------------------------------------------------
// HTML building blocks
// ---------------------------------------------------------------------------

const STYLES = `
@page { size: 80mm auto; margin: 0; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: "Courier New", Courier, "Liberation Mono", "DejaVu Sans Mono", monospace; font-size: 12px; line-height: 1.4; }
.roll { width: 80mm; max-width: 100%; margin: 0 auto; padding: 4mm 3mm 6mm; background: #fff; }
.head { text-align: center; }
.head p { margin: 0; overflow-wrap: anywhere; }
h1 { font-size: 15px; font-weight: bold; margin: 0 0 1mm; overflow-wrap: anywhere; }
h2 { font-size: 12px; font-weight: bold; margin: 0 0 1mm; text-transform: uppercase; }
.heading { font-size: 14px; font-weight: bold; letter-spacing: 0.1em; margin: 1mm 0; }
.rule { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; }
.label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; text-wrap: pretty; padding-left: 2ch; text-indent: -2ch; }
.amount { flex: 0 0 auto; text-align: right; white-space: nowrap; }
.total { font-size: 14px; font-weight: bold; margin: 1mm 0; }
.strong { font-weight: bold; }
.note { margin: 0; }
table.vat { width: 100%; border-collapse: collapse; font-size: 11px; }
table.vat th, table.vat td { padding: 0 0 0 2mm; text-align: right; font-weight: normal; white-space: nowrap; }
table.vat th:first-child, table.vat td:first-child { padding-left: 0; text-align: left; }
table.vat thead th { border-bottom: 1px dashed #000; }
footer { margin-top: 2mm; text-align: center; overflow-wrap: anywhere; }
@media screen { html, body { background: #e7e5e4; } .roll { margin: 4mm auto; box-shadow: 0 0 0 1px #d6d3d1; } }
@media print { html, body { background: #fff; } .roll { margin: 0; box-shadow: none; } }
`;

const RULE = '<hr class="rule">';

const TENDER_LABELS = { cash: 'Cash', card: 'Card' } as const satisfies Record<TenderType, string>;

/** A complete standalone document (D-108, D-110). */
function documentHtml(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<main class="roll">',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function row(label: string, value: string, className = ''): string {
  const classes = className === '' ? 'row' : `row ${className}`;
  return `<div class="${classes}"><span class="label">${escapeHtml(label)}</span> <span class="amount">${escapeHtml(value)}</span></div>`;
}

function moneyRow(label: string, amountPence: Pence, className = ''): string {
  return row(label, formatPence(amountPence), className);
}

function paragraph(text: string, className = ''): string {
  return className === '' ? `<p>${escapeHtml(text)}</p>` : `<p class="${className}">${escapeHtml(text)}</p>`;
}

function section(className: string, content: readonly string[]): string {
  return [`<section class="${className}">`, ...content, '</section>'].join('\n');
}

/** Club name, optional heading (REFUND / DEPOSIT / X READ / Z REPORT n), then one line per fact. */
function header(clubName: string, heading: string | undefined, facts: readonly string[]): string {
  return [
    '<header class="head">',
    `<h1>${escapeHtml(clubName)}</h1>`,
    ...(heading === undefined ? [] : [paragraph(heading, 'heading')]),
    ...facts.map((fact) => paragraph(fact)),
    '</header>',
  ].join('\n');
}

function receiptFacts(model: ReceiptHeader): string[] {
  return [formatDateTime(model.createdAt), `Receipt: ${model.receiptNumber}`, `Served by: ${model.staffName}`];
}

/** TOTAL, each tender in order (signed), then Change when > 0 (D-107). */
function paymentSection(totalPence: Pence, tenders: readonly Tender[], changePence: Pence): string {
  return section('payment', [
    moneyRow('TOTAL', totalPence, 'total'),
    ...tenders.map((tender) => moneyRow(TENDER_LABELS[tender.type], tender.amountPence)),
    ...(changePence > 0 ? [moneyRow('Change', changePence)] : []),
  ]);
}

function vatTable(rows: readonly VatSummaryRow[]): string {
  const body =
    rows.length === 0
      ? ['<tr><td colspan="4">None</td></tr>']
      : rows.map(
          (r) =>
            `<tr><td>${escapeHtml(`${r.vatRate}%`)}</td><td>${formatPence(r.netPence)}</td><td>${formatPence(r.vatPence)}</td><td>${formatPence(r.grossPence)}</td></tr>`,
        );
  return [
    '<table class="vat">',
    '<thead><tr><th scope="col">Rate</th><th scope="col">Net</th><th scope="col">VAT</th><th scope="col">Gross</th></tr></thead>',
    '<tbody>',
    ...body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

function vatSection(rows: readonly VatSummaryRow[]): string {
  return section('vat-summary', ['<h2>VAT summary</h2>', vatTable(rows)]);
}

function footer(text: string): string {
  return `<footer>${escapeMultiline(text)}</footer>`;
}

// ---------------------------------------------------------------------------
// Receipts (D-107, D-108)
// ---------------------------------------------------------------------------

function saleBody(model: SaleReceiptModel): string {
  const facts = receiptFacts(model);
  if (model.tabLabel !== undefined) facts.push(`Tab: ${model.tabLabel}`);
  if (model.bookingName !== undefined) facts.push(`Booking: ${model.bookingName}`);
  return [
    header(model.clubName, undefined, facts),
    RULE,
    section('items', itemRows(model).map((r) => moneyRow(r.label, r.amountPence))),
    RULE,
    paymentSection(model.totalPence, model.tenders, model.changePence),
    RULE,
    vatSection(model.vatSummary),
    RULE,
    footer(model.footer),
  ].join('\n');
}

function refundBody(model: RefundReceiptModel): string {
  const facts = [...receiptFacts(model), `Refund of ${model.originalReceiptNumber}`];
  return [
    header(model.clubName, 'REFUND', facts),
    RULE,
    section('items', itemRows(model).map((r) => moneyRow(r.label, r.amountPence))),
    RULE,
    // Refunds never give change (D-032); the tender carries the negative total.
    paymentSection(model.totalPence, model.tenders, 0),
    RULE,
    vatSection(model.vatSummary),
    RULE,
    footer(model.footer),
  ].join('\n');
}

function depositBody(model: DepositReceiptModel): string {
  const { booking } = model;
  const facts = [
    ...receiptFacts(model),
    `Deposit — ${booking.name} (${BOOKING_TYPE_LABELS[booking.type]}, ${formatLocalDate(booking.date)})`,
  ];
  return [
    header(model.clubName, 'DEPOSIT', facts),
    RULE,
    paymentSection(model.amountPence, model.tenders, model.changePence),
    RULE,
    section('deposit-balance', [
      paragraph(`Deposit balance now ${formatPence(model.balanceAfterPence)}`, 'strong'),
      paragraph(DEPOSIT_VAT_NOTE, 'note'),
    ]),
    RULE,
    footer(model.footer),
  ].join('\n');
}

/** Sale, deposit or refund receipt document (D-107, D-108). Title: 'Receipt {receiptNumber}'. */
export function renderReceipt(model: ReceiptModel): string {
  let body: string;
  switch (model.kind) {
    case 'sale':
      body = saleBody(model);
      break;
    case 'refund':
      body = refundBody(model);
      break;
    case 'deposit':
      body = depositBody(model);
      break;
  }
  return documentHtml(`Receipt ${model.receiptNumber}`, body);
}

// ---------------------------------------------------------------------------
// X and Z reports (D-041, D-046, D-047, D-108)
// ---------------------------------------------------------------------------

/**
 * The figures shared by X and Z, in the D-108 order. Deal discounts, member discounts and
 * refunds print as negatives; everything else prints as its signed value; counts as integers
 * (D-005, D-041).
 */
function figureSections(f: PeriodFigures): string[] {
  return [
    section('sales', [
      '<h2>Sales</h2>',
      moneyRow('Gross sales', f.grossSalesPence),
      moneyRow('Deal discounts', negate(f.dealDiscountsPence)),
      moneyRow('Member discounts', negate(f.memberDiscountsPence)),
      moneyRow('Refunds', negate(f.refundsPence)),
      moneyRow('Net takings', f.netTakingsPence, 'strong'),
    ]),
    RULE,
    section('cash', [
      '<h2>Cash</h2>',
      moneyRow('Cash tendered', f.cashTenderedPence),
      moneyRow('Change given', f.changeGivenPence),
      moneyRow('Cash refunded', f.cashRefundedPence),
      moneyRow('Cash total', f.cashTotalPence, 'strong'),
    ]),
    RULE,
    section('card', [
      '<h2>Card</h2>',
      moneyRow('Card tendered', f.cardTenderedPence),
      moneyRow('Card refunded', f.cardRefundedPence),
      moneyRow('Card total', f.cardTotalPence, 'strong'),
    ]),
    RULE,
    section('deposits', [
      '<h2>Deposits</h2>',
      moneyRow('Deposits taken', f.depositsTakenPence),
      moneyRow('Deposits applied', f.depositsAppliedPence),
    ]),
    RULE,
    section('counts', ['<h2>Counts</h2>', row('No sales', String(f.noSaleCount)), row('Voids', String(f.voidCount))]),
    RULE,
    section('vat-summary', ['<h2>VAT by rate</h2>', vatTable(f.vatByRate)]),
    RULE,
    section('drawer', ['<h2>Drawer</h2>', moneyRow('Float', f.floatPence), moneyRow('Expected cash', f.expectedCashPence, 'strong')]),
  ];
}

/** 'Variance (short)' below zero, 'Variance (over)' above, plain 'Variance' at exactly zero (D-041, D-108). */
function varianceLabel(variancePence: Pence): string {
  if (variancePence < 0) return 'Variance (short)';
  if (variancePence > 0) return 'Variance (over)';
  return 'Variance';
}

/** X report document (D-041, D-046). Title: 'X read'. */
export function renderXReport(model: XReportModel): string {
  const facts = [
    `Printed: ${formatDateTime(model.printedAt)} by ${model.printedByName}`,
    `Period opened: ${formatDateTime(model.openedAt)} by ${model.openedByName}`,
  ];
  const body = [header(model.clubName, 'X READ', facts), RULE, ...figureSections(model.figures)].join('\n');
  return documentHtml('X read', body);
}

/** Z report document (D-041, D-047). Title: 'Z report {zNumber}'. */
export function renderZReport(model: ZReportModel): string {
  const { figures } = model;
  const facts = [
    `Opened: ${formatDateTime(model.openedAt)} by ${model.openedByName}`,
    `Closed: ${formatDateTime(model.closedAt)} by ${model.closedByName}`,
  ];
  const body = [
    header(model.clubName, `Z REPORT ${model.zNumber}`, facts),
    RULE,
    ...figureSections(figures),
    RULE,
    section('declared', [
      '<h2>Cash-up</h2>',
      moneyRow('Declared cash', figures.declaredCashPence),
      moneyRow(varianceLabel(figures.variancePence), figures.variancePence, 'strong'),
    ]),
  ].join('\n');
  return documentHtml(`Z report ${model.zNumber}`, body);
}
