<script lang="ts">
  import Logo from './Logo.svelte';
  import IdentityRecoveryPanel from '@iris/svelte-ui/IdentityRecoveryPanel.svelte';
  import type { IdentityRecoveryRequest } from '@iris/svelte-ui';
  import { createDriveProfile, linkDriveDevice, recoverDriveProfileWithAppKey } from '../nostr';
  import { driveRootPath, isCompleteDeviceLinkOwnerInput, normalizeOwnerNpub } from '../drive/setup';
  import { navigate } from '../utils/navigate';

  type SetupMode = 'welcome' | 'create' | 'restore' | 'link';
  interface Props {
    initialOwnerInput?: string;
  }

  let { initialOwnerInput = '' }: Props = $props();
  let mode = $state<SetupMode>('welcome');
  let busy = $state(false);
  let profileIdInput = $state('');
  let ownerInput = $state('');
  let submittedOwnerInput = $state('');
  let error = $state('');
  let appliedInitialOwnerInput = $state('');

  let title = $derived(
    mode === 'create'
      ? 'Create profile'
      : mode === 'restore'
        ? 'Sign in'
        : 'Link this app',
  );

  function selectMode(nextMode: SetupMode) {
    mode = nextMode;
    error = '';
  }

  function goBack() {
    mode = 'welcome';
    error = '';
  }

  $effect(() => {
    const value = initialOwnerInput.trim();
    if (!value || value === appliedInitialOwnerInput) return;
    appliedInitialOwnerInput = value;
    mode = 'link';
    ownerInput = value;
    submittedOwnerInput = '';
    error = '';
  });

  $effect(() => {
    if (mode !== 'link' || busy) return;
    const value = ownerInput.trim();
    if (!value || value === submittedOwnerInput || !isCompleteDeviceLinkOwnerInput(value)) return;
    submitOwnerInput(value, false);
  });

  async function runAction(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  async function handleCreate(event: SubmitEvent) {
    event.preventDefault();
    await runAction(async () => {
      const profile = await createDriveProfile();
      navigate(driveRootPath(profile.npub));
    });
  }

  async function handleRecovery(request: IdentityRecoveryRequest) {
    const profileId = profileIdInput.trim();
    if (!profileId) {
      error = 'Enter your Iris profile id';
      return;
    }

    await runAction(async () => {
      try {
        const profile = await recoverDriveProfileWithAppKey({
          profileId,
          recovery: request,
          label: 'Drive web',
        });
        profileIdInput = '';
        navigate(driveRootPath(profile.npub));
      } catch (recoveryError) {
        error = recoveryError instanceof Error ? recoveryError.message : 'Recovery failed';
        return;
      }
    });
  }

  async function submitOwnerInput(value: string, force: boolean) {
    const trimmed = value.trim();
    if (!trimmed) {
      if (force) error = 'Enter owner public key or invite link';
      return;
    }

    if (trimmed.replace(/^nostr:/i, '').toLowerCase().startsWith('https://drive.iris.to/invite/')) {
      submittedOwnerInput = trimmed;
      const linked = await linkDriveDevice(trimmed);
      if (!linked) {
        error = 'Invalid owner public key or invite link';
        return;
      }
      ownerInput = '';
      navigate(driveRootPath(linked.npub));
      return;
    }

    const npub = normalizeOwnerNpub(trimmed);
    if (!npub) {
      if (force || isCompleteDeviceLinkOwnerInput(trimmed)) {
        error = 'Invalid owner public key or invite link';
      }
      return;
    }

    submittedOwnerInput = trimmed;
    ownerInput = '';
    navigate(driveRootPath(npub));
  }

  function handleLink(event: SubmitEvent) {
    event.preventDefault();
    submitOwnerInput(ownerInput, true);
  }
</script>

<div class="flex flex-1 items-center justify-center px-4 py-8 bg-surface-0" data-testid="drive-setup">
  <section class="w-full max-w-96 flex flex-col gap-6">
    {#if mode === 'welcome'}
      <div class="flex justify-center">
        <Logo />
      </div>

      <div class="grid gap-2">
        <button
          type="button"
          class="btn-success min-h-13 w-full justify-start rounded-lg px-4 text-base flex items-center gap-3"
          onclick={() => selectMode('create')}
        >
          <span class="i-lucide-plus text-lg"></span>
          <span>Create profile</span>
        </button>

        <button
          type="button"
          class="btn-ghost min-h-13 w-full justify-start rounded-lg px-4 text-base flex items-center gap-3"
          onclick={() => selectMode('restore')}
        >
          <span class="i-lucide-key-round text-lg"></span>
          <span>Sign in</span>
        </button>
      </div>
      <a
        class="text-center text-sm text-text-3 hover:text-text-1"
        href="https://irisdrive.iris.to/"
        target="_blank"
        rel="noreferrer"
      >
        Get native app
      </a>
    {:else}
      {#if mode === 'restore'}
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="btn-circle btn-ghost shrink-0"
              aria-label="Back"
              title="Back"
              onclick={goBack}
              disabled={busy}
            >
              <span class="i-lucide-arrow-left"></span>
            </button>
            <h1 class="text-xl font-semibold">{title}</h1>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-sm font-semibold text-text-3">Iris profile id</span>
            <input
              type="text"
              class="input w-full"
              bind:value={profileIdInput}
              placeholder="019e..."
              aria-label="Iris profile id"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              disabled={busy}
            />
          </label>

          <IdentityRecoveryPanel
            disabled={busy || !profileIdInput.trim()}
            error={error}
            submitLabel="Recover app key"
            nostrAvailable={typeof window !== 'undefined' && Boolean(window.nostr)}
            onSubmit={handleRecovery}
          />

          <button
            type="button"
            class="btn-ghost w-full flex items-center justify-center gap-2"
            onclick={() => selectMode('link')}
            disabled={busy}
          >
            <span class="i-lucide-monitor-up"></span>
            <span>Link this app</span>
          </button>
        </div>
      {:else}
        <form
          class="flex flex-col gap-4"
          onsubmit={mode === 'create' ? handleCreate : handleLink}
        >
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn-circle btn-ghost shrink-0"
            aria-label="Back"
            title="Back"
            onclick={goBack}
            disabled={busy}
          >
            <span class="i-lucide-arrow-left"></span>
          </button>
          <h1 class="text-xl font-semibold">{title}</h1>
        </div>

        {#if mode === 'link'}
          <input
            type="text"
            class="input w-full"
            bind:value={ownerInput}
            placeholder="Owner public key or invite link"
            aria-label="Owner public key or invite link"
            autocomplete="off"
            disabled={busy}
          />
        {/if}

        {#if error}
          <p class="text-danger text-sm">{error}</p>
        {/if}

        <button
          type="submit"
          class="btn-success w-full flex items-center justify-center gap-2"
          disabled={busy || (mode === 'link' && !ownerInput.trim())}
        >
          {#if busy}
            <span class="i-lucide-loader-2 animate-spin"></span>
          {:else if mode === 'create'}
            <span class="i-lucide-plus"></span>
          {:else}
            <span class="i-lucide-monitor-up"></span>
          {/if}
          <span>{mode === 'link' ? 'Link app' : title}</span>
        </button>
      </form>
      {/if}
    {/if}
  </section>
</div>
