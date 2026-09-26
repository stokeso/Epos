/**
 * Backup export/import and the reminder (spec §8; D-088..D-093), the draft basket
 * (D-094..D-096), and the product sales and VAT reports (spec §6.11; D-044, D-045, D-103).
 */
import { describe, expect, it } from 'vitest';
import { parseBackupText } from '../../../src/data/backup';
import type { BackupFile } from '../../../src/data/types';
import { EMPTY_BASKET } from '../../../src/rules/basket';
import { login } from '../../../src/services/auth';
import { checkBackupFile, exportBackup, importBackup, isBackupReminderDue } from '../../../src/services/backup';
import { saveBooking } from '../../../src/services/bookings';
import { setProductActive } from '../../../src/services/catalogue';
import { restoreDraft, saveDraft } from '../../../src/services/draft';
import { approveOverride } from '../../../src/services/override';
import { commitRefund } from '../../../src/services/refunds';
import { runProductSalesReport, runVatReport, todayLocal } from '../../../src/services/reports';
import { openNewTab } from '../../../src/services/tabs';
import {
  auth,
  basket,
  card,
  cash,
  expectAppError,
  initialiseTill,
  makeHarness,
  PINS,
  registerCleanup,
  sell,
  setupTill,
  T0,
  takeDeposit,
  type Till,
} from './harness';

registerCleanup();

const DAY_MS = 86_400_000;

describe('backup export (D-088, D-091)', () => {
  it('stamps lastBackupAt, audits the export and returns a valid file that contains both', async () => {
    const t = await setupTill();
    const period = await t.h.repos.periods.getOpen();
    const download = await exportBackup(t.h.ctx, auth(t.manager, 'backup'));
    expect(download.exportedAt).toBe(T0);
    expect(download.fileName).toBe('club-epos-backup-2026-09-26-1100.json');

    const parsed = parseBackupText(download.json, download.json.length);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    const file = parsed.file;
    const settings = await t.h.repos.settings.get();
    expect(file).toMatchObject({ format: 'club-epos-backup', version: 1, exportedAt: T0, deviceId: settings?.deviceId });
    expect(file.tables.settings[0]?.lastBackupAt).toBe(T0);
    expect(settings?.lastBackupAt).toBe(T0);
    const exportEvent = file.tables.auditEvents.find((e) => e.type === 'backupExport');
    expect(exportEvent).toMatchObject({ staffId: t.manager.staffId, periodId: period?.id, detail: { exportedAt: T0 } });
    expect(file.tables).toEqual(await t.h.repos.exportAll());
    expect(JSON.stringify(file.tables)).not.toContain('"draft"');
    await expectAppError(exportBackup(t.h.ctx, auth(t.manager, 'salesReports')), 'PERMISSION_DENIED');
  });
});

describe('backup import (D-089, D-090)', () => {
  async function exported(t: Till): Promise<{ text: string; file: BackupFile }> {
    await sell(t.h.ctx, t.staff, basket([[t.c.lager, 2]]), [cash(1000)]);
    const { json } = await exportBackup(t.h.ctx, auth(t.manager, 'backup'));
    const parsed = parseBackupText(json, json.length);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    return { text: json, file: parsed.file };
  }

  it('checks a file and summarises it for the confirmation screen', async () => {
    const t = await setupTill();
    const { text, file } = await exported(t);
    const same = await checkBackupFile(t.h.ctx, text, text.length);
    if (!same.ok) throw new Error('expected ok');
    expect(same.summary).toMatchObject({ exportedAt: T0, deviceId: file.deviceId, devicePrefix: '3F9C', differentDevice: false });
    expect(same.summary.rowCounts).toMatchObject({ staff: 3, categories: 4, products: 5, deals: 1, members: 1, sales: 1, settings: 1, periods: 1 });
    expect(same.summary.rowCounts.outbox).toBe(file.tables.outbox.length);

    const other = await makeHarness();
    await initialiseTill(other);
    const elsewhere = await checkBackupFile(other.ctx, text, text.length);
    expect(elsewhere.ok && elsewhere.summary.differentDevice).toBe(true);

    expect(await checkBackupFile(t.h.ctx, '{not json', 9)).toEqual({ ok: false, problems: ['The file is not valid JSON'] });
    expect(await checkBackupFile(t.h.ctx, text, 51 * 1024 * 1024)).toEqual({ ok: false, problems: ['The file is larger than 50 MB'] });
  });

  it('replaces every table after the typed confirmation and audits the import (D-090)', async () => {
    const source = await setupTill();
    const { file } = await exported(source);
    const sourcePeriod = await source.h.repos.periods.getOpen();

    const target = await makeHarness({ start: '2026-09-27T09:00:00.000Z' });
    const importer = await initialiseTill(target, 'Other Club');
    await saveDraft(target.ctx, { lines: [{ productId: 'x', qty: 1 }] });
    await expectAppError(
      importBackup(target.ctx, auth(importer, 'backup'), { file, confirmation: 'replace', importerName: importer.name }),
      'VALIDATION',
      'Type REPLACE to confirm',
    );
    await expectAppError(
      importBackup(target.ctx, auth(importer, 'backup'), { file: { ...file, tables: { ...file.tables, settings: [] } }, confirmation: 'REPLACE', importerName: importer.name }),
      'INVALID_BACKUP',
    );

    await importBackup(target.ctx, auth(importer, 'backup'), { file, confirmation: 'REPLACE', importerName: importer.name });

    const after = await target.repos.exportAll();
    expect({ ...after, auditEvents: file.tables.auditEvents, outbox: file.tables.outbox }).toEqual(file.tables);
    const added = after.auditEvents.slice(file.tables.auditEvents.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      type: 'backupImport',
      staffId: importer.staffId,
      periodId: sourcePeriod?.id,
      deviceId: file.deviceId,
      createdAt: '2026-09-27T09:00:00.000Z',
      detail: { fileExportedAt: T0, fileDeviceId: file.deviceId, importedByName: 'Morgan Manager' },
    });
    expect(added[0]).not.toHaveProperty('approvedById');
    expect(await target.repos.draft.get()).toBeUndefined();
    expect((await target.repos.settings.get())?.clubName).toBe('Oakfield Golf Club');
    // The imported staff can log in; the till carries on the imported numbering.
    expect((await login(target.ctx, PINS.staff))?.name).toBe('Sam Staff');
    expect((await target.repos.settings.get())?.receiptCounter).toBe(1);
  });

  it('writes the override before the import event when a supervisor is approved', async () => {
    const source = await setupTill({ floatPence: null });
    const { json } = await exportBackup(source.h.ctx, auth(source.manager, 'backup'));
    const parsed = parseBackupText(json, json.length);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    const file = parsed.file;
    const approval = await approveOverride(source.h.ctx, source.supervisor, 'backup', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    await importBackup(source.h.ctx, approval, { file, confirmation: 'REPLACE', importerName: 'Sue Supervisor' });
    const events = await source.h.repos.auditEvents.list();
    expect(events.slice(-2).map((e) => [e.type, e.staffId, e.approvedById])).toEqual([
      ['override', source.supervisor.staffId, source.manager.staffId],
      ['backupImport', source.supervisor.staffId, source.manager.staffId],
    ]);
    expect(events.at(-1)).not.toHaveProperty('periodId');
  });
});

describe('backup reminder (D-093)', () => {
  it('reminds managers only, from exactly 7 days after the last backup (or setup)', async () => {
    const t = await setupTill({ floatPence: null });
    expect(await isBackupReminderDue(t.h.ctx, t.manager)).toBe(false);
    t.h.clock.set(new Date(Date.parse(T0) + 7 * DAY_MS - 1).toISOString());
    expect(await isBackupReminderDue(t.h.ctx, t.manager)).toBe(false);
    t.h.clock.set(new Date(Date.parse(T0) + 7 * DAY_MS).toISOString());
    expect(await isBackupReminderDue(t.h.ctx, t.manager)).toBe(true);
    expect(await isBackupReminderDue(t.h.ctx, t.supervisor)).toBe(false);
    await exportBackup(t.h.ctx, auth(t.manager, 'backup'));
    expect(await isBackupReminderDue(t.h.ctx, t.manager)).toBe(false);
  });
});

describe('draft basket (D-094..D-096)', () => {
  it('saves the draft after a change and deletes it when the basket is empty, with no outbox entries', async () => {
    const t = await setupTill();
    const before = await t.h.repos.outbox.count();
    await saveDraft(t.h.ctx, basket([[t.c.lager, 2]], { memberId: t.c.member.id }));
    expect(await t.h.repos.draft.get()).toEqual({ id: 'current', lines: [{ productId: t.c.lager.id, qty: 2 }], memberId: t.c.member.id, updatedAt: T0 });
    await saveDraft(t.h.ctx, EMPTY_BASKET);
    expect(await t.h.repos.draft.get()).toBeUndefined();
    expect(await t.h.repos.outbox.count()).toBe(before);
    expect(await restoreDraft(t.h.ctx)).toBeNull();
  });

  it('restores the basket as saved when nothing is stale', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { type: 'society', name: 'Seniors', date: '2026-10-10', notes: '' });
    await takeDeposit(t.h.ctx, t.staff, booking.id, 2000, [cash(2000)]);
    const saved = basket([[t.c.lager, 2], [t.c.crisps, 1]], { memberId: t.c.member.id, bookingId: booking.id });
    await saveDraft(t.h.ctx, saved);
    const draft = await t.h.repos.draft.get();
    expect(await restoreDraft(t.h.ctx)).toEqual({ basket: saved, removedCount: 0 });
    expect(await t.h.repos.draft.get()).toEqual(draft);
  });

  it('drops missing products, a missing member and a used-up booking, keeping inactive products (D-096)', async () => {
    const t = await setupTill();
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { type: 'other', name: 'Quiz', date: '2026-10-10', notes: '' });
    await setProductActive(t.h.ctx, auth(t.manager, 'editCatalogue'), t.c.bitter.id, false);
    await saveDraft(t.h.ctx, {
      lines: [
        { productId: t.c.bitter.id, qty: 1 },
        { productId: 'deleted-product', qty: 2 },
      ],
      memberId: 'missing-member',
      bookingId: booking.id,
    });
    t.h.clock.advance(1000);
    const restored = await restoreDraft(t.h.ctx);
    expect(restored).toEqual({ basket: { lines: [{ productId: t.c.bitter.id, qty: 1 }] }, removedCount: 3 });
    expect(await t.h.repos.draft.get()).toEqual({ id: 'current', lines: [{ productId: t.c.bitter.id, qty: 1 }], updatedAt: t.h.clock.iso() });
  });

  it('discards the whole draft when its tab is no longer open', async () => {
    const t = await setupTill();
    const { tab } = await openNewTab(t.h.ctx, auth(t.staff, 'tabs'), basket([[t.c.lager, 1]]), 'name', 'Smith');
    const loaded = { lines: [{ productId: t.c.lager.id, qty: 1 }], tabId: tab.id };
    await saveDraft(t.h.ctx, loaded);
    expect(await restoreDraft(t.h.ctx)).toEqual({ basket: loaded, removedCount: 0 });
    await sell(t.h.ctx, t.staff, loaded, [cash(450)]);
    await saveDraft(t.h.ctx, loaded);
    expect(await restoreDraft(t.h.ctx)).toBeNull();
    expect(await t.h.repos.draft.get()).toBeUndefined();
  });
});

describe('product sales and VAT reports (D-044, D-045, D-103)', () => {
  it('uses the London date for today', async () => {
    const t = await setupTill({ floatPence: null });
    expect(todayLocal(t.h.ctx)).toBe('2026-09-26');
    t.h.clock.set('2026-09-25T23:30:00.000Z');
    expect(todayLocal(t.h.ctx)).toBe('2026-09-26');
  });

  it('selects sales and refunds by London day, excludes deposits and nets refunds off', async () => {
    const t = await setupTill();
    const at = (iso: string) => t.h.clock.set(iso);
    at('2026-09-25T22:59:59.999Z'); // 25/09 23:59 London
    await sell(t.h.ctx, t.staff, basket([[t.c.bitter, 1]]), [card(null)]);
    at('2026-09-25T23:00:00.000Z'); // 26/09 00:00 London
    const s1 = (await sell(t.h.ctx, t.staff, basket([[t.c.lager, 3], [t.c.crisps, 2]], { memberId: t.c.member.id }), [cash(2000)])).sale;
    const booking = await saveBooking(t.h.ctx, auth(t.staff, 'bookings'), null, { type: 'wedding', name: 'Smith', date: '2026-10-26', notes: '' });
    await takeDeposit(t.h.ctx, t.staff, booking.id, 5000, [cash(5000)]);
    await commitRefund(t.h.ctx, auth(t.manager, 'refund'), { originalSaleId: s1.id, lines: [{ lineIndex: 0, qty: 1, returnToStock: true }], tenderType: 'cash' });
    at('2026-09-26T22:59:59.999Z');
    await sell(t.h.ctx, t.staff, basket([[t.c.wineBottle, 1]]), [card(null)]);
    at('2026-09-26T23:00:00.000Z'); // 27/09 London
    await sell(t.h.ctx, t.staff, basket([[t.c.raffle, 1]]), [cash(100)]);

    const reports = auth(t.manager, 'salesReports');
    const day = await runProductSalesReport(t.h.ctx, reports, '2026-09-26', '2026-09-26');
    expect(day.range).toEqual({ fromDate: '2026-09-26', toDate: '2026-09-26', fromInclusive: '2026-09-25T23:00:00.000Z', toExclusive: '2026-09-26T23:00:00.000Z' });
    expect(day.categories.map((c) => ({ name: c.name, qty: c.qty, takings: c.takingsPence, products: c.products.map((p) => [p.name, p.qty, p.takingsPence]) }))).toEqual([
      { name: 'Draught', qty: 2, takings: 510, products: [['Lager', 2, 510]] },
      { name: 'Snacks', qty: 2, takings: 212, products: [['Crisps', 2, 212]] },
      { name: 'Wine', qty: 1, takings: 2295, products: [['Wine', 1, 2295]] },
    ]);
    expect(day.totalTakingsPence).toBe(3017);

    const vat = await runVatReport(t.h.ctx, reports, '2026-09-26', '2026-09-26');
    expect(vat.rows).toEqual([
      { vatRate: 20, grossPence: 2805, vatPence: 468, netPence: 2337 },
      { vatRate: 0, grossPence: 212, vatPence: 0, netPence: 212 },
    ]);
    expect(vat.totals).toEqual({ grossPence: 3017, vatPence: 468, netPence: 2549 });

    const span = await runProductSalesReport(t.h.ctx, reports, '2026-09-25', '2026-09-27');
    const spanVat = await runVatReport(t.h.ctx, reports, '2026-09-25', '2026-09-27');
    expect(span.totalTakingsPence).toBe(3017 + 420 + 100);
    expect(spanVat.totals.grossPence).toBe(span.totalTakingsPence);
    // Reports equal the sum of receipts (line finals of sale and refund receipts, D-042).
    const receipts = (await t.h.repos.sales.list()).filter((s) => s.kind !== 'deposit');
    expect(receipts.flatMap((s) => s.lines).reduce((a, l) => a + l.finalPence, 0)).toBe(span.totalTakingsPence);
    // Reports write nothing without an override.
    expect(await t.h.repos.auditEvents.listByType('override')).toEqual([]);
  });

  it('validates the range and records an override on its own', async () => {
    const t = await setupTill();
    const reports = auth(t.manager, 'salesReports');
    const backwards = 'Choose a valid date range: the end date must be on or after the start date';
    await expectAppError(runProductSalesReport(t.h.ctx, reports, '2026-09-27', '2026-09-26'), 'VALIDATION', backwards);
    await expectAppError(runVatReport(t.h.ctx, reports, '2026-09-26', 'not-a-date'), 'VALIDATION');
    // 31/12/9999 is a date an input accepts; the day after it has no YYYY-MM-DD form (D-128).
    const tooLate = 'End date must be 30/12/9999 or earlier';
    await expectAppError(runProductSalesReport(t.h.ctx, reports, '2026-09-26', '9999-12-31'), 'VALIDATION', tooLate);
    await expectAppError(runVatReport(t.h.ctx, reports, '9999-12-31', '9999-12-31'), 'VALIDATION', tooLate);
    // A backwards range with a too-late start still reports the order problem.
    await expectAppError(runVatReport(t.h.ctx, reports, '9999-12-31', '9999-12-30'), 'VALIDATION', backwards);
    await expectAppError(runVatReport(t.h.ctx, auth(t.manager, 'xRead'), '2026-09-26', '2026-09-26'), 'PERMISSION_DENIED');
    const approval = await approveOverride(t.h.ctx, t.supervisor, 'salesReports', PINS.manager);
    if (approval === null) throw new Error('expected approval');
    const report = await runVatReport(t.h.ctx, approval, '2026-09-26', '2026-09-26');
    expect(report.rows).toEqual([]);
    const period = await t.h.repos.periods.getOpen();
    expect((await t.h.repos.auditEvents.list()).map((e) => [e.type, e.staffId, e.approvedById, e.periodId, e.detail])).toEqual([
      ['override', t.supervisor.staffId, t.manager.staffId, period?.id, { action: 'salesReports' }],
    ]);
  });
});
