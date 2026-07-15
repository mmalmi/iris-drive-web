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
  const backendPromise = initReadonlyBackend();
  const sessionPromise = restoreSession({ autoCreate: shouldAutoCreateTestSession() });
  await Promise.all([backendPromise, sessionPromise]);
  await htreePromise;
  await waitForRelayConnection();
}

init();
if (import.meta.env.DEV && import.meta.env.VITE_TEST_MODE) {
  void import('./lib/testHelpers').then(({ setupTestHelpers }) => setupTestHelpers());
}
