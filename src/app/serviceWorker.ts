/**
 * Service worker registration (spec §1.1, §2 offline; D-113, D-133).
 *
 * vite-plugin-pwa builds an 'autoUpdate' worker: after a deploy the new worker takes over at once
 * and deletes the old build's precached files. The page must then reload onto the new build, or
 * the next lazily loaded screen asks for a chunk that no longer exists. registerSW (the plugin's
 * client) reports that moment through onNeedReload; the reload waits for any payment in flight.
 */
import { registerSW } from 'virtual:pwa-register';
import { reloadWhenNoPaymentInFlight } from './updateReload';

/** Called once from main.tsx. */
export function registerServiceWorker(): void {
  registerSW({ immediate: true, onNeedReload: () => reloadWhenNoPaymentInFlight() });
}
