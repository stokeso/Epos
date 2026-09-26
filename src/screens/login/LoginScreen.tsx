/**
 * Login (spec §6.2; D-074, D-076, D-078, D-096): PIN keypad with an explicit Enter.
 * A wrong PIN shows 'PIN not recognised'; 5 wrong PINs in a row disable the keypad for 30 s with
 * a countdown (the count is shared with the override dialog). On success the draft is restored
 * (if the basket is empty) and the route guard moves on to #/pay or #/till.
 */
import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../../app/AppShell';
import { signIn } from '../../app/auth';
import { nowMs } from '../../app/clock';
import { FullScreenFrame } from '../../app/FullScreen';
import { lockoutMessage, useLockoutAnnouncement, useLockoutRemaining } from '../../app/useLockout';
import { isFocusLost } from '../../components/focus';
import { PinKeypad } from '../../components/PinKeypad';
import { isBasketEmpty } from '../../rules/basket';
import { login } from '../../services/auth';
import { getCtx, useAppStore } from '../../store/appStore';
import { useBasketStore } from '../../store/basketStore';
import { usePayStore } from '../../store/payStore';
import { useSessionStore } from '../../store/sessionStore';
import styles from './LoginScreen.module.css';

export const LOGIN_REJECTED_MESSAGE = 'PIN not recognised';
export const LOGIN_PROMPT = 'Enter your PIN';

export function LoginScreen() {
  const clubName = useAppStore((s) => s.settings?.clubName ?? 'Club EPOS');
  const saleInProgress = useBasketStore((s) => !isBasketEmpty(s.basket));
  const payInProgress = usePayStore((s) => s.session !== null);
  const remaining = useLockoutRemaining();
  const lockoutAnnouncement = useLockoutAnnouncement(remaining);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Log in · Club EPOS';
    // Lock (or auto-lock) took the focused control away with the shell, and on start-up nothing
    // has focus: start on the keypad group, as the override dialog does (D-132). Screen readers
    // announce 'Enter your PIN', and Enter there submits the PIN typed (D-137).
    if (isFocusLost()) rootRef.current?.querySelector<HTMLElement>('[role="group"]')?.focus({ preventScroll: true });
  }, []);

  const submit = async (pin: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const session = await login(getCtx(), pin);
      if (session === null) {
        useSessionStore.getState().pinFailed(nowMs());
        setError(LOGIN_REJECTED_MESSAGE);
        setBusy(false);
        return;
      }
      await signIn(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  const locked = remaining > 0;
  return (
    <FullScreenFrame tone="brand">
      <div ref={rootRef} className={styles.login} data-testid="login-screen">
        <div className={styles.brand}>
          <LogoMark size={52} />
          <p className={styles.eyebrow}>Club EPOS</p>
          <h1 className={styles.club}>{clubName}</h1>
        </div>
        {(payInProgress || saleInProgress) && (
          <p className={styles.note} data-testid="sale-in-progress">
            {payInProgress ? 'A payment is in progress. It will be kept.' : 'A basket is in progress. It will be kept.'}
          </p>
        )}
        <PinKeypad
          tone="dark"
          label={LOGIN_PROMPT}
          onSubmit={(pin) => void submit(pin)}
          busy={busy}
          disabled={locked}
          error={locked ? null : error}
          status={locked ? lockoutMessage(remaining) : null}
          announcement={lockoutAnnouncement}
        />
      </div>
    </FullScreenFrame>
  );
}
