/**
 * Sign-in, lock and sign-out flows (architecture §5.12; D-078, D-090, D-093, D-096, D-112).
 */
import { isBasketEmpty } from '../rules/basket';
import type { Session } from '../services/auth';
import { isBackupReminderDue } from '../services/backup';
import { shouldWarnAboutStorage } from '../services/storage';
import { getCtx, useAppStore } from '../store/appStore';
import { useBasketStore } from '../store/basketStore';
import { usePayStore } from '../store/payStore';
import { useSessionStore, type BannerFlags } from '../store/sessionStore';
import { toast, useUiStore } from '../store/uiStore';
import { nowMs } from './clock';

export type HomeRoute = '/pay' | '/till';

/** Where to go after login: Pay when a Pay session survived the lock, else the Till (D-078). */
export function homeRoute(): HomeRoute {
  return usePayStore.getState().session === null ? '/till' : '/pay';
}

/** 'N item(s) removed from the saved basket' with the right plural (D-096). */
export function removedItemsMessage(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'} removed from the saved basket`;
}

/** Manager banners for this login (D-093, D-112). */
export async function computeBanners(session: Session): Promise<BannerFlags> {
  const backupDue = await isBackupReminderDue(getCtx(), session).catch(() => false);
  const storageStatus = useAppStore.getState().storageStatus ?? 'unsupported';
  return { backupDue, storageWarning: shouldWarnAboutStorage(storageStatus, session) };
}

/** Re-evaluates the banners for the current session (e.g. after a backup export). */
export async function refreshBanners(): Promise<void> {
  const session = useSessionStore.getState().session;
  if (session === null) return;
  const banners = await computeBanners(session);
  if (useSessionStore.getState().session === session) useSessionStore.getState().setBanners(banners);
}

/**
 * After a successful PIN (login or first-run auto-login):
 * 1. if the in-memory basket is empty, restore the draft (toast when items were dropped);
 *    otherwise (after a lock) re-price the kept basket;
 * 2. compute the manager banners;
 * 3. start the session.
 * Returns the route to show next ('/pay' or '/till').
 */
export async function signIn(session: Session): Promise<HomeRoute> {
  const basket = useBasketStore.getState();
  try {
    if (isBasketEmpty(basket.basket)) {
      const removed = await basket.restoreDraft();
      if (removed > 0) toast(removedItemsMessage(removed), { tone: 'warning' });
    } else {
      await basket.refresh();
    }
  } catch {
    toast('The saved basket could not be restored', { tone: 'danger' });
  }
  try {
    await useAppStore.getState().refreshPeriod();
  } catch {
    // The cached period stays as it was.
  }
  const banners = await computeBanners(session);
  useSessionStore.getState().start(session, nowMs());
  useSessionStore.getState().setBanners(banners);
  return homeRoute();
}

/**
 * Lock (manual or auto, D-078): cancels app-wide dialogs (a pending override resolves null)
 * and ends the session. The basket, its draft and the Pay session are kept. The route guard
 * then shows the login screen, unmounting the screen (unsaved form input is discarded).
 */
export function lock(): void {
  useUiStore.getState().cancelDialogs();
  useUiStore.getState().clearToasts();
  useSessionStore.getState().end();
}

/**
 * After a backup import (D-090): the data was replaced, so end the session, clear the basket and
 * the Pay session, and reload the cached settings and period. The guard shows the login screen.
 * The Backup screen refuses an import while a Pay session has tenders (D-134), so the Pay session
 * cleared here never has money taken on it.
 */
export async function afterBackupImport(): Promise<void> {
  useUiStore.getState().cancelDialogs();
  usePayStore.getState().clear();
  useBasketStore.getState().reset();
  useSessionStore.getState().end();
  await useAppStore.getState().refreshAll();
}
