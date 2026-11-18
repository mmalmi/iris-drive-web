<script lang="ts">
  /**
   * The account in plain terms: the name and picture others see, the devices
   * signed in to it, and switching or leaving. Keys live under Advanced.
   */
  import { currentPath, navigate } from '../../lib/router.svelte';
  import { logout, nostrStore } from '../../nostr';
  import { getCurrentNostrIdentitySession } from '../../nostr/auth';
  import { accountsStore, getAccountDisplayName, getAccountIdentityKey } from '../../accounts';
  import ProfileSettings from '@iris/svelte-ui/ProfileSettings.svelte';
  import { ownDisplayName, readOwnNameBase, saveOwnName } from '../../drive/ownDisplayName';
  import { Avatar } from '../User';
  import UserSettings from './UserSettings.svelte';
  import RecoveryPhraseSettings from './RecoveryPhraseSettings.svelte';
  import LogoutDialog from '../Modals/LogoutDialog.svelte';

  let logoutDialog = $state<LogoutDialog>();
  let profileToSignOut = $state('');
  let recoverySection = $state<HTMLElement | null>(null);
  // Backup links straight to the recovery phrase.
  $effect(() => {
    if ($currentPath === '/settings/account/recovery') recoverySection?.scrollIntoView({ block: 'start' });
  });

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let pubkey = $derived($nostrStore.pubkey ?? '');
  let profiles = $derived($accountsStore.accounts.map(account => ({
    id: getAccountIdentityKey(account),
    publicKey: account.nostrIdentityId ?? account.pubkey,
    name: getAccountDisplayName(account),
    avatarKey: account.pubkey,
  })));
  let activeProfileId = $derived(isLoggedIn ? profiles.find(profile => profile.avatarKey === pubkey)?.id ?? null : null);
  let savedName = $derived($accountsStore.accounts.find((account) => account.pubkey === pubkey)?.name?.trim() ?? '');
  let nameDraft = $state('');
  let nameSaved = $state(false);
  let publishMessage = $state('');
  let retryPublish = $state(false);
  let editBase: { pubkey: string; head: ReturnType<typeof readOwnNameBase> } | null = null;
  let attempt = 0;

  function startNameEdit() {
    if (!pubkey || editBase?.pubkey === pubkey) return;
    const head = readOwnNameBase(pubkey);
    // A read may fail before the user presses Save. Save handles that same rejection.
    void head.catch(() => {});
    editBase = { pubkey, head };
  }

  $effect(() => {
    void pubkey;
    editBase = null;
    nameSaved = false;
    retryPublish = false;
    publishMessage = '';
    attempt++;
  });
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
    if (!nameDraft.trim() || (nameDraft.trim() === savedName && !retryPublish)) return;
    startNameEdit();
    if (!editBase) return;
    const head = editBase.head;
    editBase = null;
    const request = ++attempt;
    nameSaved = true;
    retryPublish = false;
    publishMessage = 'Saved on this device. Updating your public profile…';
    void saveOwnName(pubkey, nameDraft, head).then(() => {
      if (request === attempt) publishMessage = 'Saved on this device. Your public profile update is queued.';
    }).catch((error: unknown) => {
      if (request !== attempt) return;
      retryPublish = true;
      publishMessage = 'Saved on this device. ' + (error instanceof Error ? error.message : 'Your public profile could not be updated.');
    });
  }

  function confirmProfileSignOut(id: string) {
    profileToSignOut = id;
    logoutDialog?.open();
  }

  function signOutProfile() {
    const account = $accountsStore.accounts.find(candidate => getAccountIdentityKey(candidate) === profileToSignOut);
    if (!account) return;
    if (account.pubkey === pubkey) {
      logout();
      navigate('/');
    } else {
      accountsStore.removeAccount(account.pubkey);
    }
  }
</script>

<div class="space-y-6" data-testid="account-settings" style="--iris-settings-surface: var(--surface-2)">
  <ProfileSettings
    {profiles}
    {activeProfileId}
    onSignOut={confirmProfileSignOut}
    onRemoveProfile={profiles.length > 1 ? confirmProfileSignOut : undefined}
    signInHref="#/users/existing"
    manageProfilesHref="#/users"
  >
    {#snippet profileAvatar(profile)}
      <Avatar pubkey={profiles.find(row => row.id === profile.id)?.avatarKey ?? ''} size={36} class="shrink-0" />
    {/snippet}
  </ProfileSettings>
  <LogoutDialog bind:this={logoutDialog} onConfirm={signOutProfile} removingSavedProfile={profileToSignOut !== activeProfileId} />
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
                onfocus={startNameEdit}
                oninput={() => { attempt++; nameSaved = false; retryPublish = false; publishMessage = ''; startNameEdit(); }}
                data-testid="settings-own-name"
              />
              <button
                type="submit"
                class="btn-primary text-sm"
                disabled={!nameDraft.trim() || (nameDraft.trim() === savedName && !retryPublish)}
                data-testid="settings-own-name-save"
              >
                {retryPublish ? 'Retry public update' : nameSaved && nameDraft.trim() === savedName ? 'Saved' : 'Save'}
              </button>
            </div>
          </div>
        </div>
        {#if publishMessage}<p class="text-xs text-text-2 mt-2" role="status">{publishMessage}</p>{/if}
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
  {/if}
</div>
