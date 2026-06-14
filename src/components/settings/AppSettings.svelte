<script lang="ts">
  import { shouldOpenSourceCodeLinkInNewTab } from '../../appType';
  import { getCanonicalGitRepositoryUrl } from '../../lib/shareUrls';
  import { getNsec } from '../../nostr';

  const openSourceCodeInNewTab = shouldOpenSourceCodeLinkInNewTab();
  const sourceCodeLinkTarget = openSourceCodeInNewTab ? '_blank' : '_self';
  const sourceCodeLinkRel = openSourceCodeInNewTab ? 'noopener noreferrer' : undefined;
  const hashtreeDevUrl = 'https://hashtree.cc/#/dev';
  const sourceCodeUrl = getCanonicalGitRepositoryUrl('hashtree');

  // Secret key
  let nsec = $derived(getNsec());
  let copiedNsec = $state(false);

  async function copySecretKey() {
    const key = getNsec();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      copiedNsec = true;
      setTimeout(() => (copiedNsec = false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }
</script>

<div class="space-y-6">
  <!-- Account (only show when logged in with nsec) -->
  {#if nsec}
    <div>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">
        Account
      </h3>
      <div class="bg-surface-2 rounded p-3">
        <button
          onclick={copySecretKey}
          class="btn-ghost flex items-center gap-2 text-sm w-full justify-start"
          data-testid="copy-secret-key"
        >
          {#if copiedNsec}
            <span class="i-lucide-check text-success"></span>
            <span>Copied!</span>
          {:else}
            <span class="i-lucide-key"></span>
            <span>Copy secret key</span>
          {/if}
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
