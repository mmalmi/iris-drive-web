<script lang="ts">
  /**
   * UsersPage - manage saved accounts
   * Shows list of app accounts, allows Drive user recovery, switching, and removing accounts.
   */
  import { onMount } from 'svelte';
  import AccountSwitcher from '@iris/svelte-ui/AccountSwitcher.svelte';
  import IdentityRecoveryPanel from '@iris/svelte-ui/IdentityRecoveryPanel.svelte';
  import type { IdentityCreateRequest, IdentityRecoveryRequest } from '@iris/svelte-ui';
  import { coolName, fallbackIdentityName } from '@iris/svelte-ui/profile';
  import { navigate } from '../utils/navigate';
  import {
    accountsStore,
    getAccountIdentityKey,
    saveActiveAccountToStorage,
    hasNostrExtension,
    type Account,
  } from '../accounts';
  import { createDriveProfile, linkDriveDevice, recoverDriveProfileWithAppKey, restoreSession, waitForNostrExtension } from '../nostr';
  import { parseDeviceLinkInvite } from '../drive/protocol';
  import { driveRootPath, normalizeOwnerNpub } from '../drive/setup';
  import { BackButton } from './ui';

  type UsersMode = 'list' | 'existing' | 'create' | 'no_existing';

  interface AccountSwitcherItem {
    id: string;
    name: string;
    description?: string;
    picture?: string | null;
    avatarKey?: string;
    current?: boolean;
    default?: boolean;
    removable?: boolean;
  }

  interface Props {
    mode?: UsersMode;
    embedded?: boolean;
    initialDeviceLink?: string;
  }

  let { mode = 'list', embedded = false, initialDeviceLink = '' }: Props = $props();

  // State
  let recoveryError = $state('');
  let recoveryBusy = $state(false);
  let creatingProfile = $state(false);
  let isExistingMode = $derived(mode === 'existing');
  let isCreateMode = $derived(mode === 'create');
  let isNoExistingMode = $derived(mode === 'no_existing');
  let isSecondaryMode = $derived(isExistingMode || isCreateMode || isNoExistingMode);
  let headerTitle = $derived(isCreateMode || isNoExistingMode ? 'Create new' : isExistingMode ? 'Sign in' : 'Users');
  let backHref = $derived(isNoExistingMode ? '/users/existing' : '/users');
  let initialRecoveryRequest = $derived<IdentityRecoveryRequest | null>(
    initialDeviceLink.trim()
      ? { method: 'nip46', nip46Connection: initialDeviceLink.trim() }
      : null,
  );

  // Store values
  let accountsState = $derived($accountsStore);
  let accounts = $derived(accountsState.accounts);
  let activeAccountPubkey = $derived(accountsState.activeAccountPubkey);
  let hasExtension = $state(hasNostrExtension());

  // Sort accounts by creation time (oldest first)
  let sortedAccounts = $derived(
    [...accounts].sort((a, b) => a.addedAt - b.addedAt)
  );
  let accountOptions = $derived(sortedAccounts.map(accountSwitcherItem));

  onMount(() => {
    if (hasExtension) return;

    let cancelled = false;

    waitForNostrExtension(5000).then((available) => {
      if (!cancelled) {
        hasExtension = available;
      }
    });

    return () => {
      cancelled = true;
    };
  });

  async function switchToAccount(account: Account) {
    if (account.pubkey === activeAccountPubkey) {
      navigate('/settings/user');
      return;
    }

    // Save as active
    saveActiveAccountToStorage(account.pubkey);
    accountsStore.setActiveAccount(account.pubkey);

    await restoreSession({ autoCreate: false });
  }

  function confirmRemoveAccount(pubkey: string) {
    accountsStore.removeAccount(pubkey);
  }

  async function handleGenerateNew(request?: IdentityCreateRequest) {
    if (creatingProfile) return;
    const name = request?.name?.trim() ?? '';
    if (!name) {
      recoveryError = 'Name is required';
      return;
    }
    creatingProfile = true;
    recoveryError = '';
    try {
      const profile = await createDriveProfile({ name });
      navigate(driveRootPath(profile.profileId));
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : 'Profile creation failed';
    } finally {
      creatingProfile = false;
    }
  }

  async function handleRecovery(request: IdentityRecoveryRequest) {
    if (recoveryBusy) return;
    recoveryBusy = true;
    recoveryError = '';
    try {
      const linkInput = request.method === 'nip46' ? request.nip46Connection?.trim() : '';
      if (linkInput) {
        if (parseDeviceLinkInvite(linkInput)) {
          const linked = await linkDriveDevice(linkInput);
          if (!linked) {
            throw new Error('Invalid Drive link');
          }
          navigate('/settings/user');
          return;
        }
        const ownerNpub = normalizeOwnerNpub(linkInput);
        if (ownerNpub) {
          navigate(driveRootPath(ownerNpub));
          return;
        }
      }
      const profile = await recoverDriveProfileWithAppKey({
        recovery: request,
      });
      navigate(driveRootPath(profile.session.profileId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery failed';
      if (isRecoveryIdentityMiss(message)) {
        navigate('/users/no_existing');
        return;
      }
      recoveryError = message;
    } finally {
      recoveryBusy = false;
    }
  }

  function handleRecoveryMethodChange() {
    recoveryError = '';
  }

  function accountSwitcherItem(account: Account): AccountSwitcherItem {
    const isActive = account.pubkey === activeAccountPubkey;
    return {
      id: getAccountIdentityKey(account),
      name: accountDisplayName(account),
      description: account.nostrIdentityId ? 'Drive user' : account.npub,
      avatarKey: account.pubkey,
      current: isActive,
      removable: accounts.length > 1,
    };
  }

  function accountDisplayName(account: Account): string {
    const explicitName = account.name?.trim();
    if (explicitName) return explicitName;
    if (account.nostrIdentityId) return fallbackIdentityName(account.nostrIdentityId);
    return coolName(account.pubkey);
  }

  async function selectAccount(option: AccountSwitcherItem): Promise<void> {
    const account = sortedAccounts.find(candidate => getAccountIdentityKey(candidate) === option.id);
    if (!account) return;
    await switchToAccount(account);
  }

  function removeAccount(option: AccountSwitcherItem): void {
    const account = sortedAccounts.find(candidate => getAccountIdentityKey(candidate) === option.id);
    if (!account) return;
    confirmRemoveAccount(account.pubkey);
  }

  function shouldAutoSubmitRecoveryRequest(request: IdentityRecoveryRequest): boolean {
    const linkInput = request.method === 'nip46' ? request.nip46Connection?.trim() : '';
    if (!linkInput) return false;
    return Boolean(parseDeviceLinkInvite(linkInput) || normalizeOwnerNpub(linkInput));
  }

  function isRecoveryIdentityMiss(message: string): boolean {
    return message.includes('No Drive user found')
      || message.includes('No Drive identity found')
      || message.includes('No identity roster events found');
  }
</script>

<div class={embedded ? 'w-full' : 'flex-1 flex flex-col min-h-0 bg-surface-0 p-6 max-w-2xl mx-auto w-full'}>
  <!-- Header -->
  {#if !embedded || isSecondaryMode}
  <div class="flex items-center gap-4 mb-6">
    {#if isSecondaryMode}
      <button
        type="button"
        class="btn-circle btn-ghost shrink-0"
        aria-label="Back to users"
        title="Back"
        onclick={() => navigate(backHref)}
        disabled={recoveryBusy || creatingProfile}
        data-testid="back-to-profile-actions"
      >
        <span class="i-lucide-arrow-left"></span>
      </button>
      <h1 class="text-xl font-semibold">{headerTitle}</h1>
    {:else}
      <BackButton href="/" />
      <h1 class="text-xl font-semibold">Users</h1>
    {/if}
  </div>
  {/if}

  {#if isExistingMode}
    <div class="identity-recovery-shell bg-surface-1 rounded-lg p-4 space-y-3" data-testid="identity-recovery-section">
      <IdentityRecoveryPanel
        methodLayout="column"
        disabled={recoveryBusy || creatingProfile}
        error={recoveryError}
        submitLabel="Continue"
        nostrAvailable={hasExtension}
        showNip46Relay={false}
        initialRequest={initialRecoveryRequest}
        autoSubmitInitial={Boolean(initialRecoveryRequest)}
        shouldAutoSubmit={shouldAutoSubmitRecoveryRequest}
        onMethodChange={handleRecoveryMethodChange}
        onSubmit={handleRecovery}
      />
    </div>
  {:else if isCreateMode || isNoExistingMode}
    <div class="identity-recovery-shell bg-surface-1 rounded-lg p-4 space-y-3" data-testid="identity-recovery-create-screen">
      <IdentityRecoveryPanel
        methodLayout="column"
        disabled={recoveryBusy || creatingProfile}
        showCreateNew={true}
        showCreateNewName={true}
        createNewNameRequired={true}
        createNewNameLabel="Name"
        createNewNamePlaceholder="Ada Lovelace"
        showNip46Relay={false}
        createNewTitle={isNoExistingMode ? 'No existing Drive user found for that key' : 'Create Drive user'}
        createNewDescription="This name is used for your Drive user profile."
        createNewLabel={isNoExistingMode ? 'Create new' : 'Create'}
        createNewBusy={creatingProfile}
        createNewDisabled={recoveryBusy || creatingProfile}
        createNewTestId="create-new-after-recovery-miss"
        onCreateNew={handleGenerateNew}
        onCreateNewBack={() => navigate('/users/existing')}
      />
    </div>
  {:else}
    <div class="account-switcher-shell mb-6" data-testid="drive-account-switcher">
      <AccountSwitcher
        accounts={accountOptions}
        showAddForm={false}
        onSelect={selectAccount}
        onRemove={removeAccount}
      />
    </div>

    <!-- Add account section -->
    <div class="space-y-3">
      <button
        onclick={() => navigate('/users/create')}
        class="btn-success w-full justify-center"
        data-testid="generate-new-account"
        disabled={creatingProfile}
      >
        {#if creatingProfile}
          <span class="i-lucide-loader-2 animate-spin"></span>
        {:else}
          <span class="i-lucide-plus"></span>
        {/if}
        Create new
      </button>

      <button
        type="button"
        onclick={() => navigate('/users/existing')}
        class="btn-ghost w-full justify-center border border-surface-3"
        data-testid="add-existing-profile"
        disabled={creatingProfile}
      >
        <span class="i-lucide-key-round"></span>
        Add existing
      </button>
    </div>
  {/if}
</div>

<style>
  .identity-recovery-shell {
    --accent: #28a745;
    --accent-contrast: #fff;
    --control-bg: rgb(var(--surface-2));
    --control-hover: rgb(var(--surface-3));
    --control-border: rgb(var(--surface-3));
    --control-selected-bg: color-mix(in srgb, var(--accent) 18%, rgb(var(--surface-2)));
    --danger-text: #ff4d4f;
    --line: rgb(var(--surface-3));
    --surface-raised: rgb(var(--surface-0));
    --text: rgb(var(--text-1));
    --text-muted: rgb(var(--text-2));
  }

  .identity-recovery-shell :global(.recovery-methods) {
    grid-template-columns: minmax(0, 1fr);
  }

  .account-switcher-shell {
    --accent: #28a745;
    --control-bg: rgb(var(--surface-2));
    --control-hover: rgb(var(--surface-3));
    --control-border: rgb(var(--surface-3));
    --control-selected-bg: rgb(var(--surface-2));
    --surface: rgb(var(--surface-1));
    --text: rgb(var(--text-1));
    --text-muted: rgb(var(--text-3));
  }

  .account-switcher-shell :global(.account-list:empty) {
    display: none;
  }
</style>
