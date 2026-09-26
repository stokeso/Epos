/**
 * First run (spec §6.1; D-099, D-111, D-112, D-124, D-127): club name, the first manager's name
 * and PIN (entered twice) and an optional 'Load sample data'. Submit runs
 * services/setup.completeFirstRun (validation, PIN hashing, initialise, sample data,
 * navigator.storage.persist) and then logs the manager in, landing on the Till.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signIn } from '../../app/auth';
import { FullScreenFrame } from '../../app/FullScreen';
import { LogoMark } from '../../app/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { CheckboxField, TextField } from '../../components/FormField';
import { isAppError } from '../../data/errors';
import { completeFirstRun } from '../../services/setup';
import { getCtx, useAppStore } from '../../store/appStore';
import styles from './SetupScreen.module.css';

type FieldErrors = Readonly<Record<string, string>>;

const digitsOnly = (value: string): string => value.replace(/\D/g, '').slice(0, 6);

export function SetupScreen() {
  const [clubName, setClubName] = useState('');
  const [managerName, setManagerName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loadSampleData, setLoadSampleData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    document.title = 'Set up · Club EPOS';
  }, []);

  // After a rejected submit, put the cursor in the first field that needs fixing.
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrors]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const session = await completeFirstRun(getCtx(), { clubName, managerName, pin, confirmPin, loadSampleData });
      const app = useAppStore.getState();
      await app.refreshStorageStatus();
      await signIn(session);
      // bootState becomes 'login' here, so the setup guard moves on to the Till.
      await app.refreshAll();
    } catch (error) {
      if (isAppError(error, 'VALIDATION') && error.fieldErrors !== undefined) {
        setFieldErrors(error.fieldErrors);
        setFormError('Check the highlighted details.');
      } else if (isAppError(error, 'CONFLICT')) {
        setFormError(error.message);
        await useAppStore.getState().refreshAll();
      } else {
        setFormError(error instanceof Error ? error.message : String(error));
      }
      setBusy(false);
    }
  };

  return (
    <FullScreenFrame wide>
      <div className={styles.card}>
        <div className={styles.head}>
          <LogoMark size={44} />
          <div>
            <p className={styles.eyebrow}>Club EPOS</p>
            <h1 className={styles.title}>Set up this till</h1>
          </div>
        </div>
        <p className={styles.intro}>This device has no till set up yet. Create the first manager to get started. Everything stays on this device.</p>

        <form ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate aria-describedby={formError === null ? undefined : 'setup-error'}>
          {formError !== null && (
            <div id="setup-error">
              <Banner tone="danger">{formError}</Banner>
            </div>
          )}
          <TextField
            label="Club name"
            value={clubName}
            onChange={setClubName}
            error={fieldErrors.clubName}
            autoComplete="organization"
            maxLength={40}
            required
            disabled={busy}
          />
          <TextField
            label="Manager name"
            hint="Your name. You will be the first manager."
            value={managerName}
            onChange={setManagerName}
            error={fieldErrors.managerName}
            autoComplete="name"
            maxLength={40}
            required
            disabled={busy}
          />
          <div className={styles.pinRow}>
            <TextField
              label="PIN"
              hint="4 to 6 digits"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]*"
              value={pin}
              onChange={(value) => setPin(digitsOnly(value))}
              error={fieldErrors.pin}
              required
              disabled={busy}
            />
            <TextField
              label="Confirm PIN"
              hint="Enter it again"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]*"
              value={confirmPin}
              onChange={(value) => setConfirmPin(digitsOnly(value))}
              error={fieldErrors.confirmPin}
              required
              disabled={busy}
            />
          </div>
          <div className={styles.sample}>
            <CheckboxField
              label="Load sample data"
              checked={loadSampleData}
              onChange={setLoadSampleData}
              disabled={busy}
              hint="Adds 40 products in 7 categories, 2 deals, 20 members, 2 bookings and two sample staff: Sam Staff (PIN 1111) and Sue Supervisor (PIN 2222)."
            />
          </div>
          <Button type="submit" variant="primary" size="lg" block busy={busy}>
            {busy ? 'Setting up…' : 'Set up till'}
          </Button>
        </form>
      </div>
    </FullScreenFrame>
  );
}
