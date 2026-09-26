// @vitest-environment jsdom
/**
 * Receipt and X/Z documents (spec §6.10, §6.11; D-005, D-107..D-110).
 * Every figure is hand-computed from the worked examples in docs/decisions.md (D-017, D-023,
 * D-031, D-037, D-042, D-107). Documents are parsed with DOMParser so assertions read the text a
 * person would see, not the markup.
 */
import { describe, expect, it } from 'vitest';
import type { SaleLine } from '../../src/data/types';
import {
  DEPOSIT_VAT_NOTE,
  RECEIPT_CSP,
  escapeHtml,
  itemRows,
  renderReceipt,
  renderXReport,
  renderZReport,
  type DepositReceiptModel,
  type RefundReceiptModel,
  type SaleReceiptModel,
  type XReportModel,
  type ZReportModel,
} from '../../src/receipt';
import type { PeriodFigures } from '../../src/rules/cashup';
import { zFigures } from '../../src/rules/cashup';
import { buildRefundSale } from '../../src/rules/refund';
import { priceBasket, toSaleLines, type PricingLine } from '../../src/rules/pricing';
import { vatSummary } from '../../src/rules/vat';
import type { Deal, Sale } from '../../src/data/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function text(node: Element | null): string {
  return must(node, 'element').textContent;
}

/** Every `.row` inside `scope` as 'label  amount' (two spaces, like the D-107 examples). */
function rowsIn(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll('.row')).map((row) => `${text(row.querySelector('.label'))}  ${text(row.querySelector('.amount'))}`);
}

function sectionRows(doc: Document, className: string): string[] {
  return rowsIn(must(doc.querySelector(`section.${className}`), `section.${className}`));
}

function headerFacts(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('header.head p')).map((p) => p.textContent);
}

function vatCells(doc: Document): string[][] {
  return Array.from(doc.querySelectorAll('table.vat tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent));
}

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;

/** Checks every document shares: doctype, charset, CSP, 80 mm till roll, monospace, no scripts (D-108..D-110). */
function expectStandaloneDocument(html: string, title: string): Document {
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('<html lang="en-GB">');
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain(CSP_META);
  expect(html).toContain('@page { size: 80mm auto; margin: 0; }');
  expect(html).toContain('width: 80mm');
  expect(html).toContain('monospace');
  expect(html.toLowerCase()).not.toContain('<script');
  expect(html).not.toMatch(/\son[a-z]+=/i);
  const doc = parse(html);
  expect(doc.title).toBe(title);
  expect(must(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).getAttribute('content')).toBe(RECEIPT_CSP);
  expect(doc.querySelectorAll('script').length).toBe(0);
  return doc;
}

function saleLine(fields: Partial<SaleLine> & Pick<SaleLine, 'nameAtSale' | 'qty' | 'unitPricePence' | 'finalPence' | 'vatPence'>): SaleLine {
  return {
    productId: `p-${fields.nameAtSale}`,
    vatRate: 20,
    dealDiscountPence: 0,
    memberDiscountPence: 0,
    ...fields,
  };
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Fixtures from the worked examples
// ---------------------------------------------------------------------------

/** 26/09/2026 14:05 London (BST). */
const AT = '2026-09-26T13:05:12.345Z';

const HEADER = {
  clubName: 'Oakfield Golf Club',
  footer: 'Thank you for your custom',
  createdAt: AT,
  staffName: 'Sam Staff',
} as const;

// Sale S1 (D-020, D-042, D-107): Lager x3 @450 with 'Lager 3 for 2', Crisps x2 @125 at 0%, member #1042.
const S1_LAGER = saleLine({ nameAtSale: 'Lager', qty: 3, unitPricePence: 450, dealDiscountPence: 450, memberDiscountPence: 135, finalPence: 765, vatPence: 128 });
const S1_CRISPS = saleLine({ nameAtSale: 'Crisps', qty: 2, unitPricePence: 125, vatRate: 0, memberDiscountPence: 38, finalPence: 212, vatPence: 0 });

function s1(overrides: Partial<SaleReceiptModel> = {}): SaleReceiptModel {
  const lines = [S1_LAGER, S1_CRISPS];
  return {
    ...HEADER,
    kind: 'sale',
    receiptNumber: '3F9C-000042',
    lines,
    dealLines: [{ dealId: 'deal-lager', name: 'Lager 3 for 2', groupCount: 1, savingPence: 450 }],
    memberNumber: '1042',
    memberDiscountPence: 173,
    depositAppliedPence: 0,
    totalPence: 977,
    tenders: [{ type: 'cash', amountPence: 2000 }],
    changePence: 1023,
    vatSummary: vatSummary(lines),
    ...overrides,
  };
}

// Sale S3 (D-023, D-029, D-042): Wine x4 @2295 with 5000 deposit applied; card 3000 + cash 1500, change 320.
const S3_WINE = saleLine({ nameAtSale: 'Wine', qty: 4, unitPricePence: 2295, finalPence: 9180, vatPence: 1530 });

function s3(overrides: Partial<SaleReceiptModel> = {}): SaleReceiptModel {
  return {
    ...HEADER,
    kind: 'sale',
    receiptNumber: '3F9C-000044',
    lines: [S3_WINE],
    dealLines: [],
    memberDiscountPence: 0,
    depositAppliedPence: 5000,
    bookingName: 'Smith wedding',
    totalPence: 4180,
    tenders: [
      { type: 'card', amountPence: 3000 },
      { type: 'cash', amountPence: 1500 },
    ],
    changePence: 320,
    vatSummary: vatSummary([S3_WINE]),
    ...overrides,
  };
}

// Refund S4 (D-037, D-107): 1 Lager from S1 by cash.
const S4_LINE = saleLine({
  nameAtSale: 'Lager',
  qty: -1,
  unitPricePence: 450,
  dealDiscountPence: -150,
  memberDiscountPence: -45,
  finalPence: -255,
  vatPence: -43,
  refundOfLineIndex: 0,
  returnToStock: true,
});

function s4(overrides: Partial<RefundReceiptModel> = {}): RefundReceiptModel {
  return {
    ...HEADER,
    staffName: 'Morgan Manager',
    kind: 'refund',
    receiptNumber: '3F9C-000045',
    originalReceiptNumber: '3F9C-000042',
    lines: [S4_LINE],
    memberNumber: '1042',
    memberDiscountPence: -45,
    totalPence: -255,
    tenders: [{ type: 'cash', amountPence: -255 }],
    vatSummary: vatSummary([S4_LINE]),
    ...overrides,
  };
}

// Deposit S2 (D-024, D-108): 5000 cash for "Smith wedding".
function s2(overrides: Partial<DepositReceiptModel> = {}): DepositReceiptModel {
  return {
    ...HEADER,
    kind: 'deposit',
    receiptNumber: '3F9C-000043',
    booking: { name: 'Smith wedding', type: 'wedding', date: '2026-10-24' },
    amountPence: 5000,
    tenders: [{ type: 'cash', amountPence: 5000 }],
    changePence: 0,
    balanceAfterPence: 5000,
    ...overrides,
  };
}

// The D-042 worked period.
const D042_FIGURES: PeriodFigures = {
  grossSalesPence: 10780,
  dealDiscountsPence: 450,
  memberDiscountsPence: 173,
  refundsPence: 255,
  netTakingsPence: 9902,
  depositsTakenPence: 5000,
  depositsAppliedPence: 5000,
  cashTenderedPence: 8500,
  changeGivenPence: 1343,
  cashRefundedPence: 255,
  cashTotalPence: 6902,
  cardTenderedPence: 3000,
  cardRefundedPence: 0,
  cardTotalPence: 3000,
  vatByRate: [
    { vatRate: 20, grossPence: 9690, vatPence: 1615, netPence: 8075 },
    { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
  ],
  floatPence: 10000,
  expectedCashPence: 16902,
  noSaleCount: 1,
  voidCount: 2,
};

/** The D-108 figure order with D-042 values; discounts and refunds print negative (D-041). */
const D042_FIGURE_ROWS = {
  sales: ['Gross sales  £107.80', 'Deal discounts  -£4.50', 'Member discounts  -£1.73', 'Refunds  -£2.55', 'Net takings  £99.02'],
  cash: ['Cash tendered  £85.00', 'Change given  £13.43', 'Cash refunded  £2.55', 'Cash total  £69.02'],
  card: ['Card tendered  £30.00', 'Card refunded  £0.00', 'Card total  £30.00'],
  deposits: ['Deposits taken  £50.00', 'Deposits applied  £50.00'],
  counts: ['No sales  1', 'Voids  2'],
  drawer: ['Float  £100.00', 'Expected cash  £169.02'],
};
const D042_VAT_CELLS = [
  ['20%', '£80.75', '£16.15', '£96.90'],
  ['0%', '£2.12', '£0.00', '£2.12'],
];

function xModel(overrides: Partial<XReportModel> = {}): XReportModel {
  return {
    kind: 'X',
    clubName: 'Oakfield Golf Club',
    printedAt: '2026-09-26T21:30:00.000Z',
    printedByName: 'Sue Supervisor',
    openedAt: '2026-09-26T08:00:00.000Z',
    openedByName: 'Morgan Manager',
    figures: D042_FIGURES,
    ...overrides,
  };
}

function zModel(declaredCashPence: number, overrides: Partial<ZReportModel> = {}): ZReportModel {
  return {
    kind: 'Z',
    clubName: 'Oakfield Golf Club',
    zNumber: 7,
    openedAt: '2026-09-26T08:00:00.000Z',
    openedByName: 'Morgan Manager',
    closedAt: '2026-09-26T22:15:00.000Z',
    closedByName: 'Morgan Manager',
    figures: zFigures(D042_FIGURES, declaredCashPence),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeHtml (D-110)
// ---------------------------------------------------------------------------

describe('escapeHtml (D-110)', () => {
  it('escapes & < > " and \'', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  });

  it('leaves safe text alone and escapes existing entities again (no double decoding)', () => {
    expect(escapeHtml('House Rosé (175ml) £5.50 — 20%')).toBe('House Rosé (175ml) £5.50 — 20%');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeHtml('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// itemRows (D-107)
// ---------------------------------------------------------------------------

describe('itemRows (D-107)', () => {
  it('lists sale S1 lines, deal lines and the member discount, summing to TOTAL', () => {
    const rows = itemRows(s1());
    expect(rows).toEqual([
      { label: '3 x Lager @ £4.50', amountPence: 1350 },
      { label: '2 x Crisps @ £1.25', amountPence: 250 },
      { label: 'Lager 3 for 2', amountPence: -450 },
      { label: 'Member discount (#1042)', amountPence: -173 },
    ]);
    expect(sum(rows.map((r) => r.amountPence))).toBe(977);
  });

  it('prints the group count on a deal applied more than once and omits x1 (D-017)', () => {
    const lager = saleLine({ nameAtSale: 'Lager', qty: 5, unitPricePence: 450, dealDiscountPence: 200, finalPence: 2050, vatPence: 342 });
    const model = s1({
      lines: [lager],
      dealLines: [{ dealId: 'deal-2for8', name: '2 for £8', groupCount: 2, savingPence: 200 }],
      memberDiscountPence: 0,
      totalPence: 2050,
      tenders: [{ type: 'card', amountPence: 2050 }],
      changePence: 0,
      vatSummary: vatSummary([lager]),
    });
    delete model.memberNumber;
    const rows = itemRows(model);
    expect(rows).toEqual([
      { label: '5 x Lager @ £4.50', amountPence: 2250 },
      { label: '2 for £8 x2', amountPence: -200 },
    ]);
    expect(sum(rows.map((r) => r.amountPence))).toBe(2050);
  });

  it('prints the member line at £0.00 whenever a member is attached, and not at all without one', () => {
    const withMember = itemRows(s3({ memberNumber: '1001' }));
    expect(withMember).toContainEqual({ label: 'Member discount (#1001)', amountPence: 0 });
    expect(Object.is(must(withMember.find((r) => r.label.startsWith('Member')), 'member row').amountPence, -0)).toBe(false);
    expect(itemRows(s3()).some((r) => r.label.startsWith('Member'))).toBe(false);
  });

  it('adds Deposit applied only when it is above zero (D-023)', () => {
    expect(itemRows(s3())).toEqual([
      { label: '4 x Wine @ £22.95', amountPence: 9180 },
      { label: 'Deposit applied', amountPence: -5000 },
    ]);
    expect(itemRows(s1()).some((r) => r.label === 'Deposit applied')).toBe(false);
  });

  it('gives a refund its negative lines and positive discount lines (D-107)', () => {
    const rows = itemRows(s4());
    expect(rows).toEqual([
      { label: '-1 x Lager @ £4.50', amountPence: -450 },
      { label: 'Deal discount', amountPence: 150 },
      { label: 'Member discount (#1042)', amountPence: 45 },
    ]);
    expect(sum(rows.map((r) => r.amountPence))).toBe(-255);
  });

  it('omits the refund deal line when no deal was refunded, and never yields -0', () => {
    const line = saleLine({ nameAtSale: 'Free Tee', qty: -1, unitPricePence: 0, finalPence: 0, vatPence: 0, refundOfLineIndex: 0, returnToStock: true });
    const rows = itemRows(s4({ lines: [line], memberDiscountPence: 0, totalPence: 0, tenders: [], vatSummary: vatSummary([line]) }));
    expect(rows).toEqual([
      { label: '-1 x Free Tee @ £0.00', amountPence: 0 },
      { label: 'Member discount (#1042)', amountPence: 0 },
    ]);
    for (const r of rows) expect(Object.is(r.amountPence, -0)).toBe(false);
  });

  it('always sums to TOTAL for priced baskets and their refunds (pricing and refund rules)', () => {
    const deals: Deal[] = [
      { id: 'd1', deviceId: 'dev', createdAt: AT, updatedAt: AT, name: 'Any 2 bottles for £8', type: 'nForPrice', n: 2, pricePence: 800, productIds: ['a', 'b', 'c'], active: true },
      { id: 'd2', deviceId: 'dev', createdAt: AT, updatedAt: AT, name: 'Snacks 3 for 2', type: 'nForM', n: 3, m: 2, productIds: ['c', 'd', 'e'], active: true },
    ];
    const catalogue: Omit<PricingLine, 'qty'>[] = [
      { productId: 'a', name: 'Birdie', unitPricePence: 450, vatRate: 20, memberDiscountEligible: true },
      { productId: 'b', name: 'Albatross', unitPricePence: 430, vatRate: 20, memberDiscountEligible: true },
      { productId: 'c', name: 'Crisps', unitPricePence: 125, vatRate: 0, memberDiscountEligible: true },
      { productId: 'd', name: 'Peanuts', unitPricePence: 150, vatRate: 20, memberDiscountEligible: true },
      { productId: 'e', name: 'Raffle', unitPricePence: 100, vatRate: 0, memberDiscountEligible: false },
    ];
    let seed = 20260926;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i++) {
      const lines = catalogue.filter(() => random(3) > 0).map((p) => ({ ...p, qty: 1 + random(6) }));
      if (lines.length === 0) continue;
      const member = random(2) === 0;
      const balance = random(3) === 0 ? random(5000) : null;
      const priced = priceBasket({ lines, deals, at: AT, memberDiscountPercent: member ? 15 : null, depositBalancePence: balance });
      const saleLines = toSaleLines(priced);
      const saleModel: SaleReceiptModel = {
        ...HEADER,
        kind: 'sale',
        receiptNumber: 'T-000001',
        lines: saleLines,
        dealLines: priced.dealLines,
        ...(member ? { memberNumber: '1042' } : {}),
        memberDiscountPence: priced.memberDiscountPence,
        depositAppliedPence: priced.depositAppliedPence,
        totalPence: priced.totalPence,
        tenders: [],
        changePence: 0,
        vatSummary: priced.vatSummary,
      };
      expect(sum(itemRows(saleModel).map((r) => r.amountPence))).toBe(priced.totalPence);

      const original: Sale = {
        id: 'orig',
        deviceId: 'dev',
        createdAt: AT,
        updatedAt: AT,
        receiptNumber: 'T-000001',
        periodId: 'p1',
        staffId: 's1',
        kind: 'sale',
        ...(member ? { memberId: 'm1' } : {}),
        lines: saleLines,
        dealLines: priced.dealLines,
        memberDiscountPence: priced.memberDiscountPence,
        depositAppliedPence: priced.depositAppliedPence,
        totalPence: priced.totalPence,
        tenders: [],
        changePence: 0,
      };
      const refund = buildRefundSale({
        original,
        existingRefunds: [],
        lines: saleLines.map((l, lineIndex) => ({ lineIndex, qty: 1 + random(l.qty), returnToStock: true })),
        tenderType: 'cash',
        staffId: 's1',
      });
      if (!refund.ok) throw new Error(refund.errors.join('; '));
      const refundModel: RefundReceiptModel = {
        ...HEADER,
        kind: 'refund',
        receiptNumber: 'T-000002',
        originalReceiptNumber: 'T-000001',
        lines: refund.sale.lines,
        ...(member ? { memberNumber: '1042' } : {}),
        memberDiscountPence: refund.sale.memberDiscountPence,
        totalPence: refund.sale.totalPence,
        tenders: refund.sale.tenders,
        vatSummary: vatSummary(refund.sale.lines),
      };
      expect(sum(itemRows(refundModel).map((r) => r.amountPence))).toBe(refund.sale.totalPence);
    }
  });
});

// ---------------------------------------------------------------------------
// Sale receipts (D-107, D-108)
// ---------------------------------------------------------------------------

describe('renderReceipt: sale (D-107, D-108)', () => {
  it('prints every element of sale S1 with exact figures', () => {
    const doc = expectStandaloneDocument(renderReceipt(s1()), 'Receipt 3F9C-000042');
    expect(text(doc.querySelector('h1'))).toBe('Oakfield Golf Club');
    expect(headerFacts(doc)).toEqual(['26/09/2026 14:05', 'Receipt: 3F9C-000042', 'Served by: Sam Staff']);
    expect(sectionRows(doc, 'items')).toEqual([
      '3 x Lager @ £4.50  £13.50',
      '2 x Crisps @ £1.25  £2.50',
      'Lager 3 for 2  -£4.50',
      'Member discount (#1042)  -£1.73',
    ]);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £9.77', 'Cash  £20.00', 'Change  £10.23']);
    expect(Array.from(doc.querySelectorAll('table.vat thead th')).map((th) => th.textContent)).toEqual(['Rate', 'Net', 'VAT', 'Gross']);
    expect(vatCells(doc)).toEqual([
      ['20%', '£6.37', '£1.28', '£7.65'],
      ['0%', '£2.12', '£0.00', '£2.12'],
    ]);
    expect(text(doc.querySelector('footer'))).toBe('Thank you for your custom');
  });

  it('keeps label and amount readable as one line of text', () => {
    const doc = parse(renderReceipt(s1()));
    const total = must(doc.querySelector('section.payment .row.total'));
    expect(total.textContent).toBe('TOTAL £9.77');
  });

  it('prints sale S3 with the booking, deposit applied, split tenders and change', () => {
    const doc = expectStandaloneDocument(renderReceipt(s3()), 'Receipt 3F9C-000044');
    expect(headerFacts(doc)).toEqual(['26/09/2026 14:05', 'Receipt: 3F9C-000044', 'Served by: Sam Staff', 'Booking: Smith wedding']);
    expect(sectionRows(doc, 'items')).toEqual(['4 x Wine @ £22.95  £91.80', 'Deposit applied  -£50.00']);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £41.80', 'Card  £30.00', 'Cash  £15.00', 'Change  £3.20']);
    // A deposit applied changes neither the line finals nor VAT (D-021, D-023).
    expect(vatCells(doc)).toEqual([['20%', '£76.50', '£15.30', '£91.80']]);
  });

  it('prints the tab label and the member line at £0.00', () => {
    const doc = parse(renderReceipt(s3({ tabLabel: 'Table 5', memberNumber: '1001', bookingName: undefined })));
    expect(headerFacts(doc)).toContain('Tab: Table 5');
    expect(headerFacts(doc).some((fact) => fact.startsWith('Booking:'))).toBe(false);
    expect(sectionRows(doc, 'items')).toContain('Member discount (#1001)  £0.00');
  });

  it('prints a zero-total sale with no tenders and no change (D-031)', () => {
    const doc = parse(
      renderReceipt(s3({ depositAppliedPence: 9180, totalPence: 0, tenders: [], changePence: 0 })),
    );
    expect(sectionRows(doc, 'items')).toEqual(['4 x Wine @ £22.95  £91.80', 'Deposit applied  -£91.80']);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £0.00']);
    expect(vatCells(doc)).toEqual([['20%', '£76.50', '£15.30', '£91.80']]);
  });

  it('prints an exact cash payment without a Change line', () => {
    const doc = parse(renderReceipt(s1({ tenders: [{ type: 'cash', amountPence: 500 }, { type: 'cash', amountPence: 477 }], changePence: 0 })));
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £9.77', 'Cash  £5.00', 'Cash  £4.77']);
  });

  it('turns footer newlines into <br> after escaping (D-108, D-110)', () => {
    const doc = parse(renderReceipt(s1({ footer: 'Thank you\nSee you on the 19th\r\nOakfield GC' })));
    const footer = must(doc.querySelector('footer'));
    expect(footer.innerHTML).toBe('Thank you<br>See you on the 19th<br>Oakfield GC');
    expect(footer.querySelectorAll('br').length).toBe(2);
  });

  it('prints an empty footer as an empty footer', () => {
    const doc = parse(renderReceipt(s1({ footer: '' })));
    expect(must(doc.querySelector('footer')).innerHTML).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Refund receipts (D-107, D-108)
// ---------------------------------------------------------------------------

describe('renderReceipt: refund (D-107, D-108)', () => {
  it('prints REFUND, the original receipt number and negative figures', () => {
    const doc = expectStandaloneDocument(renderReceipt(s4()), 'Receipt 3F9C-000045');
    expect(text(doc.querySelector('h1'))).toBe('Oakfield Golf Club');
    expect(text(doc.querySelector('header .heading'))).toBe('REFUND');
    expect(headerFacts(doc)).toEqual(['REFUND', '26/09/2026 14:05', 'Receipt: 3F9C-000045', 'Served by: Morgan Manager', 'Refund of 3F9C-000042']);
    expect(sectionRows(doc, 'items')).toEqual(['-1 x Lager @ £4.50  -£4.50', 'Deal discount  £1.50', 'Member discount (#1042)  £0.45']);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  -£2.55', 'Cash  -£2.55']);
    expect(vatCells(doc)).toEqual([['20%', '-£2.12', '-£0.43', '-£2.55']]);
    expect(text(doc.querySelector('footer'))).toBe('Thank you for your custom');
  });

  it('prints a card refund of a whole Wine line after a deposit (D-038)', () => {
    const wine = saleLine({ nameAtSale: 'Wine', qty: -1, unitPricePence: 2295, finalPence: -2295, vatPence: -383, refundOfLineIndex: 0, returnToStock: false });
    const doc = parse(
      renderReceipt(s4({ lines: [wine], memberDiscountPence: 0, totalPence: -2295, tenders: [{ type: 'card', amountPence: -2295 }], vatSummary: vatSummary([wine]), memberNumber: undefined })),
    );
    expect(sectionRows(doc, 'items')).toEqual(['-1 x Wine @ £22.95  -£22.95']);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  -£22.95', 'Card  -£22.95']);
    expect(vatCells(doc)).toEqual([['20%', '-£19.12', '-£3.83', '-£22.95']]);
  });
});

// ---------------------------------------------------------------------------
// Deposit receipts (D-024, D-108)
// ---------------------------------------------------------------------------

describe('renderReceipt: deposit (D-024, D-108)', () => {
  it('prints DEPOSIT, the booking, amount, tenders, balance and the no-VAT note', () => {
    const doc = expectStandaloneDocument(renderReceipt(s2()), 'Receipt 3F9C-000043');
    expect(text(doc.querySelector('h1'))).toBe('Oakfield Golf Club');
    expect(headerFacts(doc)).toEqual([
      'DEPOSIT',
      '26/09/2026 14:05',
      'Receipt: 3F9C-000043',
      'Served by: Sam Staff',
      'Deposit — Smith wedding (Wedding, 24/10/2026)',
    ]);
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £50.00', 'Cash  £50.00']);
    const balance = Array.from(must(doc.querySelector('section.deposit-balance')).querySelectorAll('p')).map((p) => p.textContent);
    expect(balance).toEqual(['Deposit balance now £50.00', DEPOSIT_VAT_NOTE]);
    expect(DEPOSIT_VAT_NOTE).toBe('No VAT - deposit is a prepayment; VAT is charged on the final bill');
    expect(doc.querySelector('table.vat')).toBeNull();
    expect(doc.querySelector('section.items')).toBeNull();
    expect(text(doc.querySelector('footer'))).toBe('Thank you for your custom');
  });

  it('prints a split deposit with change and the running balance', () => {
    const doc = parse(
      renderReceipt(
        s2({
          booking: { name: 'Seniors Society Day', type: 'society', date: '2026-10-10' },
          amountPence: 6500,
          tenders: [
            { type: 'card', amountPence: 2000 },
            { type: 'cash', amountPence: 5000 },
          ],
          changePence: 500,
          balanceAfterPence: 11500,
        }),
      ),
    );
    expect(headerFacts(doc)).toContain('Deposit — Seniors Society Day (Society day, 10/10/2026)');
    expect(sectionRows(doc, 'payment')).toEqual(['TOTAL  £65.00', 'Card  £20.00', 'Cash  £50.00', 'Change  £5.00']);
    expect(text(doc.querySelector('section.deposit-balance p'))).toBe('Deposit balance now £115.00');
  });

  it('labels every booking type (D-026)', () => {
    const labels = (['wedding', 'society', 'eventTicket', 'other'] as const).map((type) => {
      const doc = parse(renderReceipt(s2({ booking: { name: 'B', type, date: '2026-12-31' } })));
      return must(headerFacts(doc).at(-1));
    });
    expect(labels).toEqual([
      'Deposit — B (Wedding, 31/12/2026)',
      'Deposit — B (Society day, 31/12/2026)',
      'Deposit — B (Event tickets, 31/12/2026)',
      'Deposit — B (Other, 31/12/2026)',
    ]);
  });

  it('prints a booking dated in years 0000-0099, which a backup may hold (D-089, D-129)', () => {
    const doc = expectStandaloneDocument(
      renderReceipt(s2({ booking: { name: 'B', type: 'wedding', date: '0026-10-10' } })),
      'Receipt 3F9C-000043',
    );
    expect(headerFacts(doc)).toContain('Deposit — B (Wedding, 10/10/0026)');
  });
});

// ---------------------------------------------------------------------------
// X and Z reports (D-041, D-042, D-046, D-047, D-108)
// ---------------------------------------------------------------------------

function expectD042Figures(doc: Document): void {
  for (const [className, expected] of Object.entries(D042_FIGURE_ROWS)) {
    expect(sectionRows(doc, className), className).toEqual(expected);
  }
  expect(vatCells(doc)).toEqual(D042_VAT_CELLS);
  // D-108 order: sales, cash, card, deposits, counts, VAT, drawer.
  const order = Array.from(doc.querySelectorAll('main > section')).map((s) => s.className);
  expect(order.slice(0, 7)).toEqual(['sales', 'cash', 'card', 'deposits', 'counts', 'vat-summary', 'drawer']);
}

describe('renderXReport (D-041, D-046, D-108)', () => {
  it('prints the heading, who and when, and every D-042 figure in order', () => {
    const doc = expectStandaloneDocument(renderXReport(xModel()), 'X read');
    expect(text(doc.querySelector('h1'))).toBe('Oakfield Golf Club');
    expect(headerFacts(doc)).toEqual(['X READ', 'Printed: 26/09/2026 22:30 by Sue Supervisor', 'Period opened: 26/09/2026 09:00 by Morgan Manager']);
    expectD042Figures(doc);
    expect(doc.querySelector('section.declared')).toBeNull();
    expect(doc.body.textContent).not.toContain('Variance');
    expect(doc.body.textContent).not.toContain('Declared cash');
  });

  it('prints an empty period with zero figures and no VAT rows', () => {
    const empty: PeriodFigures = {
      ...D042_FIGURES,
      grossSalesPence: 0,
      dealDiscountsPence: 0,
      memberDiscountsPence: 0,
      refundsPence: 0,
      netTakingsPence: 0,
      depositsTakenPence: 0,
      depositsAppliedPence: 0,
      cashTenderedPence: 0,
      changeGivenPence: 0,
      cashRefundedPence: 0,
      cashTotalPence: 0,
      cardTenderedPence: 0,
      cardRefundedPence: 0,
      cardTotalPence: 0,
      vatByRate: [],
      expectedCashPence: 10000,
      noSaleCount: 0,
      voidCount: 0,
    };
    const doc = parse(renderXReport(xModel({ figures: empty })));
    expect(sectionRows(doc, 'sales')).toEqual(['Gross sales  £0.00', 'Deal discounts  £0.00', 'Member discounts  £0.00', 'Refunds  £0.00', 'Net takings  £0.00']);
    expect(sectionRows(doc, 'counts')).toEqual(['No sales  0', 'Voids  0']);
    expect(vatCells(doc)).toEqual([['None']]);
    expect(sectionRows(doc, 'drawer')).toEqual(['Float  £100.00', 'Expected cash  £100.00']);
  });

  it('prints large figures with thousands separators (D-005)', () => {
    const doc = parse(renderXReport(xModel({ figures: { ...D042_FIGURES, grossSalesPence: 123456789 } })));
    expect(sectionRows(doc, 'sales')[0]).toBe('Gross sales  £1,234,567.89');
  });
});

describe('renderZReport (D-041, D-047, D-108)', () => {
  it('prints Z REPORT n, opened and closed, every figure, declared cash and a short variance', () => {
    const doc = expectStandaloneDocument(renderZReport(zModel(16900)), 'Z report 7');
    expect(text(doc.querySelector('h1'))).toBe('Oakfield Golf Club');
    expect(headerFacts(doc)).toEqual(['Z REPORT 7', 'Opened: 26/09/2026 09:00 by Morgan Manager', 'Closed: 26/09/2026 23:15 by Morgan Manager']);
    expectD042Figures(doc);
    expect(sectionRows(doc, 'declared')).toEqual(['Declared cash  £169.00', 'Variance (short)  -£0.02']);
    const sections = Array.from(doc.querySelectorAll('main > section')).map((s) => s.className);
    expect(sections.at(-1)).toBe('declared');
  });

  it('labels a positive variance as over', () => {
    const doc = parse(renderZReport(zModel(17000)));
    expect(sectionRows(doc, 'declared')).toEqual(['Declared cash  £170.00', 'Variance (over)  £0.98']);
  });

  it('prints an exact cash-up as a plain zero variance', () => {
    const doc = parse(renderZReport(zModel(16902)));
    expect(sectionRows(doc, 'declared')).toEqual(['Declared cash  £169.02', 'Variance  £0.00']);
  });

  it('prints the D-047 example: expected 50300, declared 50000 is £3.00 short', () => {
    const figures = zFigures({ ...D042_FIGURES, expectedCashPence: 50300 }, 50000);
    const doc = parse(renderZReport(zModel(0, { figures, zNumber: 12 })));
    expect(doc.title).toBe('Z report 12');
    expect(text(doc.querySelector('header .heading'))).toBe('Z REPORT 12');
    expect(sectionRows(doc, 'drawer')).toEqual(['Float  £100.00', 'Expected cash  £503.00']);
    expect(sectionRows(doc, 'declared')).toEqual(['Declared cash  £500.00', 'Variance (short)  -£3.00']);
  });
});

// ---------------------------------------------------------------------------
// Injection (D-110)
// ---------------------------------------------------------------------------

const EVIL = {
  club: '<script>alert("club")</script>',
  staff: `Bob "The Builder" & Co's`,
  product: '<img src=x onerror=alert(1)>',
  deal: '<b onclick="x()">2 for £8</b>',
  member: '<i>1042</i>',
  tab: '</title><script>alert(2)</script>',
  booking: '<svg onload=alert(3)>',
  footer: 'Thanks <b>all</b>\n<script>alert(4)</script> & bye',
  receipt: '<u>3F9C-000099</u>',
} as const;

/** No live markup from user text: no scripts, images, SVG, bold/italic/underline, no event handlers. */
function expectInert(html: string): Document {
  const lower = html.toLowerCase();
  for (const tag of ['<script', '<img', '<svg', '<b>', '<b ', '<i>', '<u>', '</title><']) expect(lower).not.toContain(tag);
  expect(html).not.toMatch(/<[^>]+\son[a-z]+=/i);
  const doc = parse(html);
  expect(doc.querySelectorAll('script, img, svg, b, i, u').length).toBe(0);
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) expect(attribute.name.startsWith('on')).toBe(false);
  }
  expect(doc.querySelectorAll('title').length).toBe(1);
  return doc;
}

describe('every user-supplied string is escaped (D-110)', () => {
  it('in a sale receipt', () => {
    const product = saleLine({ nameAtSale: EVIL.product, qty: 1, unitPricePence: 450, finalPence: 450, vatPence: 75 });
    const html = renderReceipt(
      s1({
        clubName: EVIL.club,
        staffName: EVIL.staff,
        receiptNumber: EVIL.receipt,
        lines: [product],
        dealLines: [{ dealId: 'd', name: EVIL.deal, groupCount: 1, savingPence: 0 }],
        memberNumber: EVIL.member,
        memberDiscountPence: 0,
        tabLabel: EVIL.tab,
        bookingName: EVIL.booking,
        footer: EVIL.footer,
        totalPence: 450,
        tenders: [{ type: 'cash', amountPence: 450 }],
        changePence: 0,
        vatSummary: vatSummary([product]),
      }),
    );
    expect(html).toContain('&lt;script&gt;alert(&quot;club&quot;)&lt;/script&gt;');
    expect(html).toContain('Bob &quot;The Builder&quot; &amp; Co&#39;s');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const doc = expectInert(html);
    expect(doc.title).toBe(`Receipt ${EVIL.receipt}`);
    expect(text(doc.querySelector('h1'))).toBe(EVIL.club);
    expect(headerFacts(doc)).toEqual([
      '26/09/2026 14:05',
      `Receipt: ${EVIL.receipt}`,
      `Served by: ${EVIL.staff}`,
      `Tab: ${EVIL.tab}`,
      `Booking: ${EVIL.booking}`,
    ]);
    expect(sectionRows(doc, 'items')).toEqual([`1 x ${EVIL.product} @ £4.50  £4.50`, `${EVIL.deal}  £0.00`, `Member discount (#${EVIL.member})  £0.00`]);
    expect(must(doc.querySelector('footer')).innerHTML).toBe('Thanks &lt;b&gt;all&lt;/b&gt;<br>&lt;script&gt;alert(4)&lt;/script&gt; &amp; bye');
  });

  it('in a refund receipt', () => {
    const line = { ...S4_LINE, nameAtSale: EVIL.product };
    const doc = expectInert(
      renderReceipt(s4({ clubName: EVIL.club, staffName: EVIL.staff, originalReceiptNumber: EVIL.receipt, memberNumber: EVIL.member, lines: [line], footer: EVIL.footer })),
    );
    expect(headerFacts(doc)).toContain(`Refund of ${EVIL.receipt}`);
    expect(sectionRows(doc, 'items')[0]).toBe(`-1 x ${EVIL.product} @ £4.50  -£4.50`);
  });

  it('in a deposit receipt', () => {
    const doc = expectInert(renderReceipt(s2({ clubName: EVIL.club, staffName: EVIL.staff, booking: { name: EVIL.booking, type: 'other', date: '2026-10-24' }, footer: EVIL.footer })));
    expect(headerFacts(doc)).toContain(`Deposit — ${EVIL.booking} (Other, 24/10/2026)`);
  });

  it('in X and Z reports', () => {
    const x = expectInert(renderXReport(xModel({ clubName: EVIL.club, printedByName: EVIL.staff, openedByName: EVIL.tab })));
    expect(headerFacts(x)).toEqual(['X READ', `Printed: 26/09/2026 22:30 by ${EVIL.staff}`, `Period opened: 26/09/2026 09:00 by ${EVIL.tab}`]);
    const z = expectInert(renderZReport(zModel(16900, { clubName: EVIL.club, openedByName: EVIL.booking, closedByName: EVIL.staff })));
    expect(text(z.querySelector('h1'))).toBe(EVIL.club);
    expect(headerFacts(z)).toEqual(['Z REPORT 7', `Opened: 26/09/2026 09:00 by ${EVIL.booking}`, `Closed: 26/09/2026 23:15 by ${EVIL.staff}`]);
  });
});
