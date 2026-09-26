/**
 * In-flow manager banners under the header (D-093, D-112). They take space in the layout and
 * never overlay buttons; each can be dismissed for the current login only.
 */
import { Banner } from '../components/Banner';
import { ButtonLink } from '../components/Button';
import { STORAGE_WARNING } from '../services/storage';
import { useSessionStore } from '../store/sessionStore';
import styles from './AppShell.module.css';

export const BACKUP_REMINDER_TEXT = 'No backup in the last 7 days';

export function Banners() {
  const banners = useSessionStore((s) => s.banners);
  const dismissed = useSessionStore((s) => s.dismissed);
  const dismiss = useSessionStore((s) => s.dismissBanner);
  const showBackup = banners.backupDue && !dismissed.backupDue;
  const showStorage = banners.storageWarning && !dismissed.storageWarning;
  if (!showBackup && !showStorage) return null;
  return (
    <div className={styles.banners}>
      {showBackup && (
        <Banner
          tone="warning"
          testId="backup-reminder"
          action={
            <ButtonLink to="/backoffice/backup" size="sm" variant="secondary">
              Back up now
            </ButtonLink>
          }
          onDismiss={() => dismiss('backupDue')}
          dismissLabel="Dismiss backup reminder"
        >
          {BACKUP_REMINDER_TEXT}
        </Banner>
      )}
      {showStorage && (
        <Banner tone="warning" testId="storage-warning" onDismiss={() => dismiss('storageWarning')} dismissLabel="Dismiss storage warning">
          {STORAGE_WARNING}
        </Banner>
      )}
    </div>
  );
}
