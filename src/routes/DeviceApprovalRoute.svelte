<script lang="ts">
  import { onMount } from 'svelte';
  import {
    approveDriveDeviceApprovalRequest,
    getCurrentNostrIdentitySession,
    parseDriveDeviceApprovalRequestInput,
    restoreSession,
  } from '../nostr';
  import { navigate } from '../utils/navigate';

  interface Props {
    payload: string;
  }

  let { payload }: Props = $props();
  let status = $state('Approving device');
  let error = $state('');
  let approvalUrl = $derived(`https://drive.iris.to/approve-device/${payload}`);

  onMount(() => {
    void approve();
  });

  async function approve(): Promise<void> {
    const request = parseDriveDeviceApprovalRequestInput(approvalUrl);
    if (!request) {
      error = 'Invalid device approval request';
      return;
    }
    try {
      if (!getCurrentNostrIdentitySession()) {
        await restoreSession({ autoCreate: false });
      }
      if (!getCurrentNostrIdentitySession()) {
        error = 'Sign in to approve this device';
        return;
      }
      await approveDriveDeviceApprovalRequest(request);
      status = 'Device approved';
      navigate('/settings/user');
    } catch (approvalError) {
      error = approvalError instanceof Error ? approvalError.message : 'Could not approve device';
    }
  }
</script>

<div class="flex flex-1 items-center justify-center bg-surface-0 px-4 py-8">
  <section class="w-full max-w-sm rounded-lg bg-surface-1 p-4 space-y-3" data-testid="device-approval-route">
    <h1 class="text-lg font-semibold text-text-1">{error ? 'Approval failed' : status}</h1>
    {#if error}
      <p class="text-sm text-danger" data-testid="device-approval-route-error">{error}</p>
      <button
        type="button"
        class="btn-primary flex w-full items-center justify-center gap-2"
        onclick={approve}
        data-testid="device-approval-route-retry"
      >
        <span class="i-lucide-refresh-cw"></span>
        <span>Retry</span>
      </button>
    {:else}
      <div class="flex items-center gap-2 text-sm text-text-3">
        <span class="i-lucide-loader-2 animate-spin"></span>
        <span>Waiting for Drive</span>
      </div>
    {/if}
  </section>
</div>
