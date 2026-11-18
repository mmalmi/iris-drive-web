import 'virtual:uno.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initServiceWorker, keepAppForOffline } from './lib/swInit';
import { restoreSession, initReadonlyBackend } from './nostr/auth';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';
import { waitForRelayConnection } from './lib/workerInit';
import { sessionRestored } from './nostr/store';

setAppType('files');

function shouldAutoCreateTestSession(): boolean {
  if (!import.meta.env.VITE_TEST_MODE) return false;
  try {
    return localStorage.getItem('hashtree:disableTestAutoCreate') !== '1';
  } catch {
    return true;
  }
}

async function init() {
  mount(App, {
    target: document.getElementById('app')!,
  });
  // The account and the backend do not wait for the service worker: on a
  // first visit it is still installing. Only files served from /htree/ need
  // it, and their connection to it waits for it by itself.
  const swPromise = initServiceWorker();
  const htreePromise = initHtreeApi();
  // Restore the stored account before the backend starts, so the backend and
  // its peer network start once with that account's key. Started first, they
  // came up with a throwaway key and had to be torn down and started again.
  const sessionPromise = restoreSession({ autoCreate: shouldAutoCreateTestSession() })
    .finally(() => sessionRestored.set(true));
  const backendPromise = sessionPromise.then(restored => {
    if (!restored) return initReadonlyBackend();
  });
  await Promise.all([backendPromise, swPromise]);
  await htreePromise;
  keepAppForOffline();
  await waitForRelayConnection();
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
