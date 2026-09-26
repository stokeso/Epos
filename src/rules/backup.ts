/**
 * Backup reminder and file naming (spec §8; D-088, D-093). Pure.
 */
import type { IsoInstant } from '../data/types';
import { fileStamp } from './time';

/** 7 x 24 hours (D-093). */
export const BACKUP_REMINDER_MS = 604_800_000;

/** The word a manager must type to enable Import (D-090). Case-sensitive. */
export const IMPORT_CONFIRMATION_WORD = 'REPLACE';

/**
 * now - (lastBackupAt ?? settingsCreatedAt) >= BACKUP_REMINDER_MS (D-093). Exactly 7 days -> true.
 */
export function isBackupDue(now: IsoInstant, lastBackupAt: IsoInstant | undefined, settingsCreatedAt: IsoInstant): boolean {
  const since = lastBackupAt ?? settingsCreatedAt;
  const nowMs = Date.parse(now);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(nowMs) || Number.isNaN(sinceMs)) throw new RangeError('isBackupDue needs valid ISO instants');
  return nowMs - sinceMs >= BACKUP_REMINDER_MS;
}

/** 'club-epos-backup-YYYY-MM-DD-HHmm.json' in London time (D-088). */
export function backupFileName(exportedAt: IsoInstant): string {
  return `club-epos-backup-${fileStamp(exportedAt)}.json`;
}
