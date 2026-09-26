/**
 * Backup (spec §8; D-088..D-093): export everything to a JSON file (sets lastBackupAt and writes
 * a backupExport audit event), or restore a file: check it first (services/backup.checkBackupFile
 * lists what is wrong or summarises it), type REPLACE, then Import replaces ALL data on this till,
 * writes a backupImport audit event and returns to the login screen. Both need 'backup'.
 * Import is refused while a payment has tenders taken: the money is in the drawer and the import
 * would drop it with no record and no hand-back instruction (D-134, as D-130 for Z close).
 */
import { useId, useState, type ChangeEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button, ButtonLink } from '../../components/Button';
import { keepFocusWhenRemoved } from '../../components/focus';
import { TextField } from '../../components/FormField';
import { Screen } from '../../components/Screen';
import { afterBackupImport, refreshBanners } from '../../app/auth';
import { downloadTextFile } from '../../app/download';
import { errorMessage } from '../../app/errors';
import type { BackupTables } from '../../data/types';
import { IMPORT_CONFIRMATION_WORD } from '../../rules/backup';
import { formatDateTime } from '../../rules/time';
import { checkBackupFile, exportBackup, importBackup, type BackupCheck } from '../../services/backup';
import { getCtx, useAppStore } from '../../store/appStore';
import { usePayStore } from '../../store/payStore';
import { useSessionStore } from '../../store/sessionStore';
import { toast } from '../../store/uiStore';
import { useGatedForm } from './formHelpers';
import { BackToMenu, FormError, Panel, PermissionNote } from './parts';
import styles from './backoffice.module.css';
import backupStyles from './BackupScreen.module.css';

/** D-134: the D-130 wording, for a backup import. */
const PAYMENT_IN_PROGRESS_IMPORT_MESSAGE = 'A payment is in progress. Finish or cancel it before importing a backup.';

/** Row counts shown before an import (settings and outbox are left out). */
const COUNT_LABELS: [keyof BackupTables, string][] = [
  ['staff', 'Staff'],
  ['categories', 'Categories'],
  ['products', 'Products'],
  ['deals', 'Deals'],
  ['members', 'Members'],
  ['bookings', 'Bookings'],
  ['tabs', 'Tabs'],
  ['sales', 'Sales'],
  ['stockMovements', 'Stock movements'],
  ['periods', 'Trading periods'],
  ['auditEvents', 'Audit events'],
];

interface Checked {
  fileName: string;
  check: BackupCheck;
}

export function BackupScreen() {
  const lastBackupAt = useAppStore((s) => s.settings?.lastBackupAt);
  const exporter = useGatedForm();
  const [lastFile, setLastFile] = useState<string | null>(null);

  const exportNow = async (): Promise<void> => {
    const download = await exporter.run('backup', (auth) => exportBackup(getCtx(), auth));
    if (download === null) return;
    downloadTextFile(download.fileName, download.json);
    setLastFile(download.fileName);
    await useAppStore.getState().refreshSettings();
    await refreshBanners();
    toast(`Backup saved as ${download.fileName}`, { tone: 'success' });
  };

  return (
    <Screen title="Backup" description="Everything on this till lives only on this device. Back it up regularly." actions={<BackToMenu />}>
      <PermissionNote action="backup">You can look around here. Exporting or importing a backup needs a manager PIN.</PermissionNote>
      <div className={backupStyles.layout}>
        <Panel title="Export a backup" description="Saves every record on this till to one file you can keep somewhere safe.">
          <Banner tone="warning" role="none">
            The file holds all takings and the staff PIN codes in scrambled form. Store it securely.
          </Banner>
          <dl className={styles.facts}>
            <dt>Last backup</dt>
            <dd data-testid="last-backup">{lastBackupAt === undefined ? 'Never' : formatDateTime(lastBackupAt)}</dd>
            {lastFile !== null && (
              <>
                <dt>File</dt>
                <dd className={backupStyles.fileName}>{lastFile}</dd>
              </>
            )}
          </dl>
          <FormError message={exporter.formError} />
          <div className={backupStyles.actions}>
            <Button variant="primary" size="lg" onClick={() => void exportNow()} busy={exporter.busy}>
              Export backup
            </Button>
          </div>
        </Panel>

        <ImportPanel />
      </div>
    </Screen>
  );
}

function ImportPanel() {
  const inputId = useId();
  const [checked, setChecked] = useState<Checked | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const importer = useGatedForm(['confirmation']);
  const paying = usePayStore((s) => s.session !== null && s.session.tender.tenders.length > 0);

  const choose = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    setReading(true);
    setReadError(null);
    setChecked(null);
    setConfirmation('');
    importer.showError(null);
    try {
      const text = await file.text();
      const check = await checkBackupFile(getCtx(), text, file.size);
      setChecked({ fileName: file.name, check });
    } catch (error) {
      setReadError(`That file couldn't be read: ${errorMessage(error)}`);
    } finally {
      setReading(false);
    }
  };

  const reset = (): void => {
    setChecked(null);
    setConfirmation('');
    setReadError(null);
    importer.showError(null);
  };

  const runImport = async (): Promise<void> => {
    if (checked === null || !checked.check.ok) return;
    const pay = usePayStore.getState().session;
    if (pay !== null && pay.tender.tenders.length > 0) {
      importer.showError(PAYMENT_IN_PROGRESS_IMPORT_MESSAGE);
      return;
    }
    const { file } = checked.check;
    const importerName = useSessionStore.getState().session?.name ?? '';
    const done = await importer.run('backup', async (auth) => {
      await importBackup(getCtx(), auth, { file, confirmation, importerName });
      return true;
    });
    if (done === null) return;
    // The data was replaced: end the session and show the login screen (D-090).
    await afterBackupImport();
    toast('Backup restored. Log in to carry on.', { tone: 'success', durationMs: 8000 });
  };

  const summary = checked?.check.ok === true ? checked.check.summary : null;
  const problems = checked?.check.ok === false ? checked.check.problems : null;
  const confirmed = confirmation === IMPORT_CONFIRMATION_WORD;

  return (
    <Panel title="Restore a backup" description="Replaces everything on this till with the backup. This can't be undone.">
      {paying && (
        <Banner tone="warning" role="none" testId="backup-payment-in-progress" action={<ButtonLink to="/pay" size="sm">Back to Pay</ButtonLink>}>
          {PAYMENT_IN_PROGRESS_IMPORT_MESSAGE}
        </Banner>
      )}
      <div className={backupStyles.fileRow}>
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          className={`visually-hidden ${backupStyles.fileInput}`}
          onChange={(event) => void choose(event)}
          disabled={reading || importer.busy}
        />
        <label htmlFor={inputId} className={`${backupStyles.fileLabel} ${reading || importer.busy ? backupStyles.fileLabelDisabled : ''}`}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M4 15.5V19a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 19v-3.5M12 14.5v-11M7.5 8L12 3.5 16.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {checked === null ? 'Choose backup file' : 'Choose another file'}
        </label>
        {reading && <span className={styles.muted}>Checking the file…</span>}
        {checked !== null && !reading && <span className={backupStyles.fileName}>{checked.fileName}</span>}
      </div>

      {readError !== null && <Banner tone="danger">{readError}</Banner>}

      {problems !== null && (
        <div className={backupStyles.problems} role="alert" data-testid="backup-problems">
          <p className={backupStyles.problemsTitle}>This file can't be imported</p>
          <ul>
            {problems.map((problem, index) => (
              <li key={`${index}-${problem}`}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {summary !== null && (
        <div className={styles.form} data-testid="backup-summary">
          <Banner tone="success" role="status" title="File checked.">
            It is a valid Club EPOS backup.
          </Banner>
          <dl className={styles.facts}>
            <dt>Exported</dt>
            <dd>{formatDateTime(summary.exportedAt)}</dd>
            <dt>Receipt prefix</dt>
            <dd className={backupStyles.fileName}>{summary.devicePrefix}</dd>
          </dl>
          {summary.differentDevice && (
            <Banner tone="warning" role="none" title="From another till.">
              This till will take over that till’s identity and receipt numbers ({summary.devicePrefix}).
            </Banner>
          )}
          <dl className={backupStyles.counts} aria-label="Records in the backup">
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className={backupStyles.count}>
                <dt>{label}</dt>
                <dd className="tabular">{summary.rowCounts[key]}</dd>
              </div>
            ))}
          </dl>
          <Banner tone="danger" role="none" title="Everything on this till will be replaced.">
            Sales, stock, members, staff and settings all come from the file. Everyone is logged out afterwards.
          </Banner>
          <TextField
            label={`Type ${IMPORT_CONFIRMATION_WORD} to confirm`}
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            error={importer.fieldErrors.confirmation}
            className={backupStyles.confirm}
          />
          <FormError message={importer.formError} />
          <div className={backupStyles.actions}>
            <Button
              onClick={(event) => {
                // Cancel clears the checked file, so the summary and this button go (D-135, D-137).
                keepFocusWhenRemoved(event.currentTarget);
                reset();
              }}
              disabled={importer.busy}
            >
              Cancel
            </Button>
            <Button variant="danger" size="lg" onClick={() => void runImport()} disabled={!confirmed || paying} busy={importer.busy}>
              Import backup
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
