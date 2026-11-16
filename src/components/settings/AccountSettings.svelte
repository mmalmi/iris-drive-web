<script lang="ts">
  /**
   * The account in plain terms: the name and picture others see, the devices
   * signed in to it, and switching or leaving. Keys live under Advanced.
   */
  import { currentPath, navigate } from '../../lib/router.svelte';
  import { nostrStore } from '../../nostr';
  import { getCurrentNostrIdentitySession } from '../../nostr/auth';
  import { accountsStore } from '../../accounts';
  import { ownDisplayName, saveOwnName } from '../../drive/ownDisplayName';
  import { Avatar } from '../User';
  import UserSettings from './UserSettings.svelte';
  import RecoveryPhraseSettings from './RecoveryPhraseSettings.svelte';
  import LogoutDialog from '../Modals/LogoutDialog.svelte';

  let logoutDialog = $state<LogoutDialog>();
  let recoverySection = $state<HTMLElement | null>(null);
  // Backup links straight to the recovery phrase.
  $effect(() => {
    if ($currentPath === '/settings/account/recovery') recoverySection?.scrollIntoView({ block: 'start' });
  });

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let pubkey = $derived($nostrStore.pubkey ?? '');
  let savedName = $derived($accountsStore.accounts.find((account) => account.pubkey === pubkey)?.name?.trim() ?? '');
  let nameDraft = $state('');
  let nameSaved = $state(false);
  // Start from the name on this device; an account without one shows the name
  // others find for it, once that lookup answers.
  $effect(() => {
    nameDraft = savedName;
    if (savedName) return;
    const session = getCurrentNostrIdentitySession();
    if (session?.status !== 'active' || session.appKeyPubkey !== pubkey) return;
    let current = true;
    void ownDisplayName(session).then((name) => { if (current && !nameDraft) nameDraft = name; });
    return () => { current = false; };
  });

  function saveName(): void {
    if (!nameDraft.trim() || nameDraft.trim() === savedName) return;
    saveOwnName(pubkey, nameDraft);
    nameSaved = true;
  }

</script>

<div class="space-y-6" data-testid="account-settings">
  {#if isLoggedIn}
    <section>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Name and picture</h3>
      <form
        class="bg-surface-2 rounded p-3"
        onsubmit={(event) => { event.preventDefault(); saveName(); }}
      >
        <div class="flex items-center gap-3">
          {#if pubkey}
            <Avatar {pubkey} size={44} class="shrink-0" />
          {/if}
          <div class="min-w-0 flex-1">
            <label class="block text-sm text-text-2 mb-1" for="settings-own-name">Your name</label>
            <div class="flex gap-2">
              <input
                id="settings-own-name"
                class="input flex-1 min-w-0"
                maxlength="80"
                autocomplete="name"
                placeholder="Name"
                bind:value={nameDraft}
                oninput={() => (nameSaved = false)}
                data-testid="settings-own-name"
              />
              <button
                type="submit"
                class="btn-primary text-sm"
                disabled={!nameDraft.trim() || nameDraft.trim() === savedName}
                data-testid="settings-own-name-save"
              >
                {nameSaved && nameDraft.trim() === savedName ? 'Saved' : 'Save'}
              </button>
            </div>
          </div>
        </div>
        <p class="text-xs text-text-3 mt-2">People you share folders with see this name and picture.</p>
      </form>
    </section>
  {/if}

  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Devices</h3>
    <UserSettings />
  </section>

  {#if isLoggedIn}
    <section id="recovery-phrase" bind:this={recoverySection} class="scroll-mt-4">
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Recovery phrase</h3>
      <RecoveryPhraseSettings />
    </section>

    <section>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Accounts</h3>
      <div class="bg-surface-2 rounded p-3 space-y-1">
        <button
          class="btn-ghost flex w-full items-center justify-start gap-2 text-sm"
          onclick={() => navigate('/users')}
          data-testid="settings-manage-users"
        >
          <span class="i-lucide-users"></span>
          <span>Switch account</span>
        </button>
        <button
          class="btn-ghost flex w-full items-center justify-start gap-2 text-sm text-danger hover:bg-danger/10"
          onclick={() => logoutDialog?.open()}
          data-testid="settings-logout"
        >
          <span class="i-lucide-log-out"></span>
          <span>Log out</span>
        </button>
      </div>
      <LogoutDialog bind:this={logoutDialog} />
    </section>
  {/if}
</div>
