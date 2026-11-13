<script lang="ts">
  import CopyButton from '@iris/svelte-ui/CopyButton.svelte';
  import { shouldOpenSourceCodeLinkInNewTab } from '../../appType';
  import { getCanonicalGitRepositoryUrl } from '../../lib/shareUrls';
  import { navigate } from '../../lib/router.svelte';
  import { getNsec, logout, nostrStore } from '../../nostr';
  import { getCurrentNostrIdentitySession } from '../../nostr/auth';
  import { accountsStore } from '../../accounts';
  import { ownDisplayName, saveOwnName } from '../../drive/ownDisplayName';

  const openSourceCodeInNewTab = shouldOpenSourceCodeLinkInNewTab();
  const sourceCodeLinkTarget = openSourceCodeInNewTab ? '_blank' : '_self';
  const sourceCodeLinkRel = openSourceCodeInNewTab ? 'noopener noreferrer' : undefined;
  const hashtreeDevUrl = 'https://hashtree.cc/#/dev';
  const sourceCodeUrl = getCanonicalGitRepositoryUrl('hashtree');

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let nsec = $derived.by(() => {
    isLoggedIn;
    return getNsec();
  });

  function handleLogout(): void {
    logout();
    navigate('/');
  }

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

<div class="space-y-6">
  {#if isLoggedIn}
    <div>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
        Account
      </h3>
      <form
        class="bg-surface-2 rounded p-3 mb-3"
        onsubmit={(event) => { event.preventDefault(); saveName(); }}
      >
        <label class="block text-sm text-text-2 mb-2" for="settings-own-name">Your name</label>
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
        <p class="text-xs text-text-3 mt-2">People you share folders with see this name.</p>
      </form>
      <div class="bg-surface-2 rounded p-3 space-y-1">
        <button
          class="btn-ghost flex w-full items-center justify-start gap-2 text-sm"
          onclick={() => navigate('/users')}
          data-testid="settings-manage-users"
        >
          <span class="i-lucide-users"></span>
          <span>Manage users</span>
        </button>
        {#if nsec}
          <CopyButton
            text={nsec}
            label="Copy secret key"
            copiedLabel="Copied"
            class="btn-ghost flex items-center gap-2 text-sm w-full justify-start"
            iconClass="i-lucide-key"
            copiedIconClass="i-lucide-check text-success"
            testId="copy-secret-key"
          />
        {/if}
        <button
          class="btn-ghost flex w-full items-center justify-start gap-2 text-sm text-danger hover:bg-danger/10"
          onclick={handleLogout}
          data-testid="settings-logout"
        >
          <span class="i-lucide-log-out"></span>
          <span>Log out</span>
        </button>
      </div>
    </div>
  {/if}

  <!-- About -->
  <div>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
      About
    </h3>
    <p class="text-sm text-text-2 mb-3">
      Built on
      <a
        href={hashtreeDevUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="ml-1 no-underline text-text-1 hover:text-text-0"
      >
        hashtree
      </a>
    </p>
    <div class="bg-surface-2 rounded p-3 text-sm space-y-3">
      <div class="flex justify-between items-center">
        <span class="text-muted">Build</span>
        <span class="text-text-1 font-mono text-xs">
          {(() => {
            const buildTime = import.meta.env.VITE_BUILD_TIME;
            if (!buildTime || buildTime === 'undefined') return 'development';
            try {
              return new Date(buildTime).toLocaleString();
            } catch {
              return buildTime;
            }
          })()}
        </span>
      </div>
      <a
        href={sourceCodeUrl}
        target={sourceCodeLinkTarget}
        rel={sourceCodeLinkRel}
        class="btn-ghost w-full flex items-center justify-center gap-2 no-underline"
      >
        <span class="i-lucide-code text-sm"></span>
        <span>hashtree</span>
        <span class="text-text-3 text-xs no-underline">(source code)</span>
      </a>
      <button
        onclick={() => window.location.reload()}
        class="btn-ghost w-full flex items-center justify-center gap-2"
      >
        <span class="i-lucide-refresh-cw text-sm"></span>
        <span>Refresh App</span>
      </button>
    </div>
  </div>
</div>
