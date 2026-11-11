import 'virtual:uno.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initServiceWorker } from './lib/swInit';
import { restoreSession, initReadonlyBackend } from './nostr/auth';
import { setAppType } from './appType';
import { initHtreeApi } from './lib/htreeApi';
import { waitForRelayConnection } from './lib/workerInit';

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
  const swPromise = initServiceWorker();
  await swPromise;
  const htreePromise = initHtreeApi();
  // Restore the stored account before the backend starts, so the backend and
  // its peer network start once with that account's key. Started first, they
  // came up with a throwaway key and had to be torn down and started again.
  const sessionPromise = restoreSession({ autoCreate: shouldAutoCreateTestSession() });
  const backendPromise = initReadonlyBackend();
  await Promise.all([backendPromise, sessionPromise]);
  await htreePromise;
  await waitForRelayConnection();
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
