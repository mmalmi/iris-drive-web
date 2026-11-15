<script lang="ts">
  import { onDestroy } from 'svelte';
  import { DEVICE_APPROVAL_BOOTSTRAP_PREFIX, parseDeviceApprovalBootstrap } from '@iris/identity';
  import { approveDriveDeviceApprovalBootstrap, nostrStore, sessionRestored } from '../nostr';
  import { activeDriveRootPath, activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { navigate } from '../utils/navigate';

  let { payload }: { payload: string } = $props();
  let bootstrap = $derived(parseDeviceApprovalBootstrap(DEVICE_APPROVAL_BOOTSTRAP_PREFIX + payload));
  let signedIn = $derived(activeNostrIdentityRootScope($nostrStore));
  let busy = $state(false);
  let error = $state('');
  let closed = false;
  onDestroy(() => { closed = true; });

  async function approve() {
    if (!bootstrap || !signedIn || busy) return;
    busy = true;
    error = '';
    try {
      await approveDriveDeviceApprovalBootstrap(bootstrap);
      if (!closed) navigate('/settings/user');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add the device';
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-1 items-center justify-center bg-surface-0 px-4 py-8">
  <section class="w-full max-w-sm rounded-lg bg-surface-1 p-5 space-y-4" data-testid="device-approval-route">
    <h1 class="text-lg font-semibold text-text-1">{bootstrap ? 'Add a device?' : 'Invalid device request'}</h1>
    {#if bootstrap}
      <p class="text-sm text-text-2">
        Allow <strong class="break-words">{bootstrap.label || 'this device'}</strong> to read and change files in your Drive?
      </p>
      {#if !bootstrap.label}
        <p class="break-all text-xs font-mono text-text-3">{bootstrap.deviceAppKeyNpub}</p>
      {/if}
      {#if $sessionRestored && !signedIn}
        <p class="text-sm text-text-2">Open this link on a device where you’re signed in to Drive.</p>
      {/if}
    {/if}
    {#if error}
      <p class="text-sm text-danger" role="alert">{error}</p>
    {/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="btn-ghost" disabled={busy} onclick={() => navigate(activeDriveRootPath($nostrStore))}>
        {bootstrap ? 'Cancel' : 'Close'}
      </button>
      {#if bootstrap}
        <button type="button" class="btn-primary" disabled={busy || !signedIn || !$sessionRestored} onclick={approve}>
          {busy ? 'Adding…' : 'Add device'}
        </button>
      {/if}
    </div>
  </section>
</div>
