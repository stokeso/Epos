/**
 * Route guards (architecture §7.1):
 * - no staff yet (bootState 'setup') -> #/setup;
 * - no session -> #/login;
 * - logged in on #/login or #/setup -> #/pay if a Pay session exists, else #/till.
 * Navigation itself is never permission-gated (D-070).
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { usePayStore } from '../store/payStore';
import { useSession } from '../store/sessionStore';

function useHome(): string {
  const bootState = useAppStore((s) => s.bootState);
  const session = useSession();
  const hasPay = usePayStore((s) => s.session !== null);
  if (bootState === 'setup') return '/setup';
  if (session === null) return '/login';
  return hasPay ? '/pay' : '/till';
}

/** '/' and unknown paths. */
export function IndexRedirect() {
  return <Navigate to={useHome()} replace />;
}

/** #/setup only while no staff exist. */
export function SetupGuard({ children }: { children: ReactNode }) {
  const bootState = useAppStore((s) => s.bootState);
  const home = useHome();
  if (bootState !== 'setup') return <Navigate to={home} replace />;
  return <>{children}</>;
}

/** #/login only when set up and logged out. */
export function LoginGuard({ children }: { children: ReactNode }) {
  const home = useHome();
  if (home !== '/login') return <Navigate to={home} replace />;
  return <>{children}</>;
}

/** Everything inside the shell needs a session. */
export function RequireSession({ children }: { children: ReactNode }) {
  const bootState = useAppStore((s) => s.bootState);
  const session = useSession();
  if (bootState === 'setup') return <Navigate to="/setup" replace />;
  if (session === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
