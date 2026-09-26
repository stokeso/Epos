/**
 * Full-screen states outside the shell: starting up, storage unavailable (D-111) and an
 * unexpected route error. Also the dark-green frame used by the Setup and Login screens.
 */
import type { ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button } from '../components/Button';
import { LogoMark } from './AppShell';
import styles from './FullScreen.module.css';

export interface FullScreenFrameProps {
  children: ReactNode;
  /** 'brand' = deep-green background (login); 'plain' = off-white (setup, errors). */
  tone?: 'brand' | 'plain';
  /** Widen the card (setup form). */
  wide?: boolean;
}

export function FullScreenFrame({ children, tone = 'plain', wide = false }: FullScreenFrameProps) {
  return (
    <div className={`${styles.frame} ${tone === 'brand' ? styles.brand : styles.plain}`}>
      <main className={`${styles.card} ${wide ? styles.wide : ''}`}>{children}</main>
    </div>
  );
}

export function BootScreen() {
  return (
    <div className={`${styles.frame} ${styles.brand}`} aria-busy="true">
      <div className={styles.boot}>
        <LogoMark size={56} />
        <p>Starting the till…</p>
      </div>
    </div>
  );
}

export function StorageErrorScreen({ message }: { message: string }) {
  return (
    <FullScreenFrame>
      <div className={styles.error} role="alert">
        <h1>{message}</h1>
        <p>
          Club EPOS keeps everything on this device in the browser&apos;s storage (IndexedDB). It could not be opened. Private browsing,
          blocked site data or low disk space can cause this.
        </p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </FullScreenFrame>
  );
}

export function RouteError() {
  const error = useRouteError();
  let detail = 'Unknown error';
  if (isRouteErrorResponse(error)) detail = `${error.status} ${error.statusText}`;
  else if (error instanceof Error) detail = error.message;
  return (
    <FullScreenFrame>
      <div className={styles.error} role="alert">
        <h1>Something went wrong</h1>
        <p>The screen hit an unexpected error. Nothing unsaved has been written. Your basket is kept as a draft.</p>
        <pre className={styles.detail}>{detail}</pre>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </FullScreenFrame>
  );
}
