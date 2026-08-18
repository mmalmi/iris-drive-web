<script lang="ts">
  import CopyButton from '@iris/svelte-ui/CopyButton.svelte';
  import { shouldOpenSourceCodeLinkInNewTab } from '../../appType';
  import { getCanonicalGitRepositoryUrl } from '../../lib/shareUrls';
  import { navigate } from '../../lib/router.svelte';
  import { getNsec, logout, nostrStore } from '../../nostr';

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
</script>

<div class="space-y-6">
  {#if isLoggedIn}
    <div>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
        Account
      </h3>
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
