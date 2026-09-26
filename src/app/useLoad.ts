/**
 * Load data from a service for a screen:
 *
 *   const tabs = useLoad((ctx) => listOpenTabs(ctx, basket), [basket]);
 *   if (tabs.data === undefined) return tabs.error ?? 'Loading…';
 *   ... <Button onClick={tabs.reload}>Refresh</Button>
 *
 * - Runs on mount, whenever a value in `deps` changes (compared as JSON, so use ids, strings,
 *   numbers or small plain objects) and on reload().
 * - `loading` is true until the result for the current deps/reload arrives; the previous `data`
 *   stays visible meanwhile. A result that a newer request has overtaken is ignored.
 * - Errors become `error` (the AppError message).
 * It avoids setState-in-effect (react-hooks lint) by only setting state when a promise settles.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { ServiceContext } from '../services/context';
import { useCtx } from '../store/appStore';
import { errorMessage } from './errors';

export interface LoadState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Runs the load again (e.g. after a save). */
  reload: () => void;
}

interface Settled<T> {
  key: string;
  data: T | undefined;
  error: string | null;
}

export function useLoad<T>(load: (ctx: ServiceContext) => Promise<T>, deps: DependencyList): LoadState<T> {
  const ctx = useCtx();
  const latestLoad = useRef(load);
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: '', data: undefined, error: null });
  const key = `${JSON.stringify(deps)}#${version}`;

  useEffect(() => {
    latestLoad.current = load;
  });

  useEffect(() => {
    let current = true;
    latestLoad.current(ctx).then(
      (data) => {
        if (current) setSettled({ key, data, error: null });
      },
      (error: unknown) => {
        if (current) setSettled((previous) => ({ key, data: previous.data, error: errorMessage(error) }));
      },
    );
    return () => {
      current = false;
    };
  }, [ctx, key]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data: settled.data, error: settled.error, loading: settled.key !== key, reload };
}
