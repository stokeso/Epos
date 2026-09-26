/**
 * 'No trading period open' + 'Open period' (spec §6.3; D-067, D-068). The Till shows it while
 * appStore.openPeriod is null; selling is disabled until a period is opened.
 */
import { useId, useState } from 'react';
import { Button } from '../components/Button';
import { OpenPeriodDialog } from './OpenPeriodDialog';
import styles from './NoPeriodPrompt.module.css';

export const NO_PERIOD_HEADING = 'No trading period open';

export interface NoPeriodPromptProps {
  className?: string;
}

export function NoPeriodPrompt({ className }: NoPeriodPromptProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  return (
    <section className={`${styles.prompt} ${className ?? ''}`} aria-labelledby={headingId} data-testid="no-period">
      <svg className={styles.icon} viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <rect x="6" y="14" width="36" height="24" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M6 22h36" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="24" cy="30" r="3" fill="currentColor" />
        <path d="M16 14v-3a8 8 0 0116 0v3" fill="none" stroke="currentColor" strokeWidth="2.5" />
      </svg>
      <h2 id={headingId} className={styles.heading}>
        {NO_PERIOD_HEADING}
      </h2>
      <p className={styles.text}>Selling is disabled until a manager opens a trading period with a float.</p>
      <Button variant="primary" size="lg" onClick={() => setOpen(true)}>
        Open period
      </Button>
      <OpenPeriodDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}
