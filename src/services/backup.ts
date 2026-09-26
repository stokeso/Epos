/**
 * Backup export/import flows and the 7-day reminder (spec §8; D-088..D-093).
 * Export and import need auth.action 'backup'. The pure file validation is src/data/backup.ts.
 */
import { parseBackupText, serialiseBackup, validateBackupValue } from '../data/backup';
import { AppError } from '../data/errors';
import type { BackupFile, BackupTables, IsoInstant, NewAuditEvent } from '../data/types';
import { BACKUP_FORMAT, SCHEMA_VERSION } from '../data/types';
import { IMPORT_CONFIRMATION_WORD, backupFileName, isBackupDue } from '../rules/backup';
import type { Session } from './auth';
import { nowIso, type ServiceContext } from './context';
import { assertAuthorised, auditActor, overrideEvents, type Authorisation } from './override';
import { getSettings } from './settings';
import { openPeriodId, validationError } from './shared';

export interface BackupDownload {
  /** backupFileName(exportedAt). */
  fileName: string;
  /** serialiseBackup(file). The UI downloads it via Blob + <a download>. */
  json: string;
  exportedAt: IsoInstant;
}

/**
 * Export (D-091): now = one clock read. transact: settings.update({ lastBackupAt: now }) +
 * auditEvents.append([...overrideEvents, backupExport { exportedAt: now }]). Then exportAll() and
 * build BackupFile { format, version: SCHEMA_VERSION, exportedAt: now, deviceId, tables }. The file
 * therefore contains its own export event and the new lastBackupAt.
 */
export async function exportBackup(ctx: ServiceContext, auth: Authorisation): Promise<BackupDownload> {
  assertAuthorised(auth, 'backup');
  const exportedAt = nowIso(ctx);
  const periodId = await openPeriodId(ctx);
  await ctx.repos.transact(async () => {
    await ctx.repos.settings.update({ lastBackupAt: exportedAt });
    await ctx.repos.auditEvents.append([
      ...overrideEvents(auth, periodId),
      { type: 'backupExport', ...auditActor(auth), ...(periodId === undefined ? {} : { periodId }), detail: { exportedAt } },
    ]);
  });
  const tables = await ctx.repos.exportAll();
  const deviceId = tables.settings[0]?.deviceId ?? (await getSettings(ctx)).deviceId;
  const file: BackupFile = { format: BACKUP_FORMAT, version: SCHEMA_VERSION, exportedAt, deviceId, tables };
  return { fileName: backupFileName(exportedAt), json: serialiseBackup(file), exportedAt };
}

export interface BackupSummary {
  exportedAt: IsoInstant;
  deviceId: string;
  devicePrefix: string;
  /** file.deviceId !== this device's Settings.deviceId -> show a warning. */
  differentDevice: boolean;
  rowCounts: Record<keyof BackupTables, number>;
}

export type BackupCheck = { ok: true; file: BackupFile; summary: BackupSummary } | { ok: false; problems: string[] };

function rowCounts(tables: BackupTables): Record<keyof BackupTables, number> {
  return {
    staff: tables.staff.length,
    categories: tables.categories.length,
    products: tables.products.length,
    deals: tables.deals.length,
    members: tables.members.length,
    bookings: tables.bookings.length,
    tabs: tables.tabs.length,
    sales: tables.sales.length,
    stockMovements: tables.stockMovements.length,
    periods: tables.periods.length,
    auditEvents: tables.auditEvents.length,
    settings: tables.settings.length,
    outbox: tables.outbox.length,
  };
}

/** parseBackupText(text, sizeBytes) + summary for the confirmation screen (D-089, D-090). Needs no permission. */
export async function checkBackupFile(ctx: ServiceContext, text: string, sizeBytes: number): Promise<BackupCheck> {
  const result = parseBackupText(text, sizeBytes);
  if (!result.ok) return { ok: false, problems: result.problems };
  const { file } = result;
  const current = await ctx.repos.settings.get();
  return {
    ok: true,
    file,
    summary: {
      exportedAt: file.exportedAt,
      deviceId: file.deviceId,
      devicePrefix: file.tables.settings[0]?.devicePrefix ?? '',
      differentDevice: current?.deviceId !== file.deviceId,
      rowCounts: rowCounts(file.tables),
    },
  };
}

export interface ImportInput {
  file: BackupFile;
  /** Must equal IMPORT_CONFIRMATION_WORD ('REPLACE') exactly, else VALIDATION error. */
  confirmation: string;
  /** Name of the logged-in importer (captured before the staff table is replaced). */
  importerName: string;
}

/** The open period in the imported data: that device's period with no closedAt (D-083, D-090). */
function importedOpenPeriodId(file: BackupFile): string | undefined {
  const settings = file.tables.settings[0];
  if (settings === undefined) return undefined;
  return file.tables.periods.find((p) => p.deviceId === settings.deviceId && p.closedAt === undefined && p.deletedAt === undefined)?.id;
}

/**
 * Import (D-090): repos.importAll(file.tables, { auditEvents: [...overrideEvents,
 * backupImport { staffId: auth.staffId, approvedById?, periodId: the imported open period's id if
 * any, detail: { fileExportedAt, fileDeviceId, importedByName } }] }).
 * The file is validated again (it may have been held in memory for a while); a failure is
 * AppError('INVALID_BACKUP'). The caller then ends the session, clears the in-memory basket and
 * shows login.
 */
export async function importBackup(ctx: ServiceContext, auth: Authorisation, input: ImportInput): Promise<void> {
  assertAuthorised(auth, 'backup');
  if (input.confirmation !== IMPORT_CONFIRMATION_WORD) {
    throw validationError({ confirmation: `Type ${IMPORT_CONFIRMATION_WORD} to confirm` });
  }
  const checked = validateBackupValue(input.file);
  if (!checked.ok) {
    throw new AppError('INVALID_BACKUP', checked.problems[0] ?? 'The backup file is not valid', { file: checked.problems.join('\n') });
  }
  const { file } = checked;
  const importerName = input.importerName.trim() || ((await ctx.repos.staff.get(auth.staffId))?.name ?? 'Unknown');
  const periodId = importedOpenPeriodId(file);
  const auditEvents: NewAuditEvent[] = [
    ...overrideEvents(auth, periodId),
    {
      type: 'backupImport',
      ...auditActor(auth),
      ...(periodId === undefined ? {} : { periodId }),
      detail: { fileExportedAt: file.exportedAt, fileDeviceId: file.deviceId, importedByName: importerName },
    },
  ];
  await ctx.repos.importAll(file.tables, { auditEvents });
}

/**
 * Banner 'No backup in the last 7 days — Back up now' (D-093): only when session.role is
 * 'manager' (own role) and isBackupDue(now, settings.lastBackupAt, settings.createdAt).
 */
export async function isBackupReminderDue(ctx: ServiceContext, session: Session): Promise<boolean> {
  if (session.role !== 'manager') return false;
  const settings = await ctx.repos.settings.get();
  if (settings === undefined) return false;
  return isBackupDue(nowIso(ctx), settings.lastBackupAt, settings.createdAt);
}
