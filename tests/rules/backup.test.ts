import { describe, expect, it } from 'vitest';
import { BACKUP_REMINDER_MS, IMPORT_CONFIRMATION_WORD, backupFileName, isBackupDue } from '../../src/rules/backup';

describe('isBackupDue (D-093)', () => {
  const created = '2026-09-01T10:00:00.000Z';

  it('is due at exactly 7 days since the last backup', () => {
    expect(BACKUP_REMINDER_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(isBackupDue('2026-09-26T10:00:00.000Z', '2026-09-19T10:00:00.000Z', created)).toBe(true);
    expect(isBackupDue('2026-09-26T09:59:59.999Z', '2026-09-19T10:00:00.000Z', created)).toBe(false);
    expect(isBackupDue('2026-09-20T10:00:00.000Z', '2026-09-19T10:00:00.000Z', created)).toBe(false);
  });

  it('falls back to when the settings were created', () => {
    expect(isBackupDue('2026-09-08T10:00:00.000Z', undefined, created)).toBe(true);
    expect(isBackupDue('2026-09-08T09:59:59.999Z', undefined, created)).toBe(false);
  });

  it('throws RangeError for invalid instants', () => {
    expect(() => isBackupDue('nope', undefined, created)).toThrow(RangeError);
    expect(() => isBackupDue('2026-09-08T10:00:00.000Z', 'nope', created)).toThrow(RangeError);
  });
});

describe('backupFileName (D-088)', () => {
  it('uses London wall-clock time', () => {
    expect(backupFileName('2026-09-26T13:05:12.345Z')).toBe('club-epos-backup-2026-09-26-1405.json');
    expect(backupFileName('2026-01-05T09:07:00.000Z')).toBe('club-epos-backup-2026-01-05-0907.json');
    expect(backupFileName('2026-09-25T23:30:00.000Z')).toBe('club-epos-backup-2026-09-26-0030.json');
  });
});

describe('IMPORT_CONFIRMATION_WORD (D-090)', () => {
  it('is REPLACE', () => {
    expect(IMPORT_CONFIRMATION_WORD).toBe('REPLACE');
  });
});
