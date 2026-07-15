/**
 * Service Worker initialization utilities
 * Shared between app entry points.
 */

import { registerSW } from 'virtual:pwa-register';
import { getHtreePrefix } from './mediaUrl';
import { shouldPreferSameOriginHtreeRoutes } from './nativeHtree';

interface InitOptions {
  /** Require cross-origin isolation (for SharedArrayBuffer/FFmpeg) */
  requireCrossOriginIsolation?: boolean;
}

/**
 * Initialize service worker and wait for it to be ready
 * Returns a promise that resolves when SW is controlling the page
 */
export async function initServiceWorker(options: InitOptions = {}): Promise<void> {
  const isTestMode = !!import.meta.env.VITE_TEST_MODE;
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const pageProtocol = typeof window !== 'undefined' ? window.location?.protocol : '';
  const isLocalDevServer = Boolean(
    !isTestMode
      && import.meta.env.DEV
      && typeof window !== 'undefined'
      && pageProtocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(window.location.hostname)
      && ['5173', '5174'].includes(window.location.port),
  );

  if ((isTestMode || isLocalDevServer) && hasServiceWorker) {
    let hadRegistrations = false;
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      hadRegistrations = registrations.length > 0;
      await Promise.all(registrations.map(reg => reg.unregister().catch(() => {})));
    } catch (err) {
      console.warn('[SW] Failed to unregister service workers in local/test mode:', err);
    }
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key).catch(() => {})));
      }
    } catch (err) {
      console.warn('[SW] Failed to clear caches in local/test mode:', err);
    }
    if (isLocalDevServer) {
      const reloadKey = 'dev-sw-cleanup-reloaded';
      if (hadRegistrations && !sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        console.log('[SW] Cleared local dev service worker cache, reloading once');
        window.location.reload();
        return new Promise(() => {});
      }
      console.log('[SW] Skipping service worker on local dev server');
      return;
    }
  }

  // Skip the service worker only when a direct local htree server can be used
  // safely. Secure HTTPS apps inside Iris still need same-origin /htree routes.
  if (getHtreePrefix()) {
    console.log('[SW] Skipping service worker (native htree server)');
    return;
  }

  // Custom htree:// child webviews cannot rely on service workers, and waiting
  // for registration there can block the app before it mounts.
  if (pageProtocol === 'htree:') {
    console.log('[SW] Skipping service worker (htree runtime)');
    return;
  }

  if (!hasServiceWorker) {
    console.log('[SW] Service workers unavailable for this runtime');
    return;
  }

  // Register service worker
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(swUrl: string) {
      console.log('[SW] Registered:', swUrl);
    },
    onNeedRefresh() {
      console.log('[SW] Update available, activating...');
      if (!isTestMode) {
        updateSW(true);
      }
    },
    onRegisterError(error: unknown) {
      console.error('[SW] Registration error:', error);
    },
  });

  // Wait for SW to be active and controlling this page
  if (!navigator.serviceWorker.controller) {
    console.log('[SW] Waiting for controller...');

    // Wait for SW to be ready (active)
    await navigator.serviceWorker.ready;

    // If still no controller after SW is ready, wait for controllerchange or reload
    if (!navigator.serviceWorker.controller) {
      const gotController = await Promise.race([
        new Promise<boolean>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            console.log('[SW] Controller now active');
            resolve(true);
          }, { once: true });
        }),
        // Small timeout just in case controllerchange already fired
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);

      // If no controller after SW is ready, reload to let SW take control
      if (!gotController && !navigator.serviceWorker.controller) {
        const isLocalChildRuntime =
          pageProtocol === 'http:' && shouldPreferSameOriginHtreeRoutes();
        if (isLocalChildRuntime || isTestMode) {
          console.log('[SW] No controller after SW ready; continuing without forced reload', {
            isLocalChildRuntime,
            isTestMode,
          });
        } else {
          console.log('[SW] No controller after SW ready, reloading...');
          window.location.reload();
          // Return a never-resolving promise since we're reloading
          return new Promise(() => {});
        }
      }
    }
  }

  // Reload once on controller change to ensure fresh assets after SW update.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const reloadKey = 'sw-reload-on-update';
    if (!sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, '1');
      console.log('[SW] Controller changed, reloading for fresh assets...');
      if (!isTestMode) {
        window.location.reload();
      }
    }
  }, { once: true });

  // Check if cross-origin isolation is required (for SharedArrayBuffer/FFmpeg)
  if (options.requireCrossOriginIsolation) {
    const coiReloadKey = 'coi-reload-attempted';
    if (navigator.serviceWorker.controller && !self.crossOriginIsolated) {
      if (isTestMode) {
        console.log('[SW] Cross-origin isolation unavailable in test mode; continuing without forced reload');
        return;
      }
      if (!sessionStorage.getItem(coiReloadKey)) {
        sessionStorage.setItem(coiReloadKey, '1');
        console.log('[SW] Not cross-origin isolated, reloading for COOP/COEP headers...');
        window.location.reload();
        return new Promise(() => {});
      } else {
        console.log('[SW] Cross-origin isolation not available after reload - FFmpeg transcoding disabled');
      }
    } else if (self.crossOriginIsolated) {
      sessionStorage.removeItem(coiReloadKey);
    }
  }
}
