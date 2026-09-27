/**
 * Transient UI state (architecture §7.2): toasts, the receipt fallback panel (D-109), the
 * pending PIN override request (D-071) and app-wide confirm dialogs.
 * The components that render these are mounted once by the root layout (src/app).
 * cancelDialogs() runs on lock (D-078): the pending override resolves null and a pending confirm
 * resolves false. The receipt fallback is kept: it may be the only copy of a receipt, X read or
 * Z report, so it is hidden while the till is locked and shown again after the next login (D-135).
 */
import { create } from 'zustand';
import type { Action } from '../data/types';
import type { Authorisation } from '../services/override';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** Default 2500 ms (6000 ms for 'danger'). */
  durationMs?: number;
}

export interface ReceiptFallback {
  html: string;
  /** The document <title> (e.g. 'Receipt 3F9C-000042'). */
  title: string;
}

export interface OverrideRequest {
  id: number;
  action: Action;
  resolve: (auth: Authorisation | null) => void;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Default 'Confirm'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** 'danger' styles the confirm button red. */
  tone?: 'default' | 'danger';
}

export interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export interface UiState {
  toasts: ToastItem[];
  receiptFallback: ReceiptFallback | null;
  overrideRequest: OverrideRequest | null;
  confirmRequest: ConfirmRequest | null;
  /** Increments on every lock; components holding their own dialogs may watch it. */
  lockCount: number;

  /** Shows a toast (aria-live). Returns its id. */
  toast(message: string, options?: ToastOptions): number;
  dismissToast(id: number): void;
  showReceiptFallback(fallback: ReceiptFallback): void;
  closeReceiptFallback(): void;
  /** Opens the override dialog; resolves with the Authorisation or null (cancelled/locked). Use requirePermission(). */
  requestOverride(action: Action): Promise<Authorisation | null>;
  /** Resolves the pending override (called by OverrideDialog). */
  settleOverride(auth: Authorisation | null): void;
  /** App-wide confirm dialog; resolves true on confirm, false on cancel or lock. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolves the pending confirm (called by the global ConfirmDialog host). */
  settleConfirm(confirmed: boolean): void;
  /** Lock: cancel the override and confirm dialogs. The receipt fallback is kept (D-135). */
  cancelDialogs(): void;
  /** Removes every toast (lock: nothing from the last user stays on screen). */
  clearToasts(): void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  receiptFallback: null,
  overrideRequest: null,
  confirmRequest: null,
  lockCount: 0,

  toast(message, options = {}) {
    const id = nextId++;
    const tone = options.tone ?? 'info';
    const durationMs = options.durationMs ?? (tone === 'danger' ? 6000 : 2500);
    // One confirmation at a time: the newest replaces the last, so toasts never stack over the
    // page. Errors keep up to two, since each may need reading (D-140).
    const current = get().toasts;
    const replaced = tone === 'danger' ? current.filter((t) => t.tone === 'danger').slice(0, -1) : current.filter((t) => t.tone !== 'danger');
    for (const old of replaced) {
      clearTimeout(timers.get(old.id));
      timers.delete(old.id);
    }
    set({ toasts: [...current.filter((t) => !replaced.includes(t)), { id, message, tone }] });
    timers.set(
      id,
      setTimeout(() => get().dismissToast(id), durationMs),
    );
    return id;
  },

  dismissToast(id) {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  showReceiptFallback(fallback) {
    set({ receiptFallback: fallback });
  },

  closeReceiptFallback() {
    set({ receiptFallback: null });
  },

  requestOverride(action) {
    get().overrideRequest?.resolve(null);
    return new Promise<Authorisation | null>((resolve) => {
      set({ overrideRequest: { id: nextId++, action, resolve } });
    });
  },

  settleOverride(auth) {
    const request = get().overrideRequest;
    set({ overrideRequest: null });
    request?.resolve(auth);
  },

  confirm(options) {
    get().confirmRequest?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({ confirmRequest: { id: nextId++, options, resolve } });
    });
  },

  settleConfirm(confirmed) {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    request?.resolve(confirmed);
  },

  clearToasts() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    set({ toasts: [] });
  },

  cancelDialogs() {
    const { overrideRequest, confirmRequest } = get();
    set({ overrideRequest: null, confirmRequest: null, lockCount: get().lockCount + 1 });
    overrideRequest?.resolve(null);
    confirmRequest?.resolve(false);
  },
}));

/** Shorthand for useUiStore.getState().toast(...), usable anywhere. */
export function toast(message: string, options?: ToastOptions): number {
  return useUiStore.getState().toast(message, options);
}

/** Shorthand for the app-wide confirm dialog. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useUiStore.getState().confirm(options);
}
