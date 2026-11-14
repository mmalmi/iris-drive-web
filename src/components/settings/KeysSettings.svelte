<script lang="ts">
  /**
   * The keys behind the account. The public key is safe to give out; the
   * secret key is shown only when asked for, under a warning, and hidden again
   * on leaving the page.
   */
  import CopyButton from '@iris/svelte-ui/CopyButton.svelte';
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import { getNsec, nostrStore } from '../../nostr';

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let publicKey = $derived($nostrStore.npub ?? '');
  let hasSecretKey = $derived.by(() => {
    isLoggedIn;
    return Boolean(getNsec());
  });
  let revealedSecretKey = $state<string | null>(null);

  function revealSecretKey(): void {
    revealedSecretKey = getNsec();
  }

  function hideSecretKey(): void {
    revealedSecretKey = null;
  }
</script>

<div class="space-y-6" data-testid="keys-settings">
  {#if !isLoggedIn}
    <p class="bg-surface-2 rounded p-3 text-sm text-text-3">Sign in to see your keys.</p>
  {:else}
    <section>
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Your public key</h3>
      <div class="bg-surface-2 rounded p-3 space-y-2">
        {#if publicKey}
          <CopyText text={publicKey} class="text-sm" testId="settings-public-key" />
        {/if}
        <p class="text-xs text-text-3">Safe to share. Others can paste it to add you to a folder.</p>
      </div>
    </section>

    <section data-testid="secret-key-section">
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">Secret key</h3>
      {#if hasSecretKey}
        <div class="rounded border border-danger/40 bg-danger/8 p-3 space-y-3">
          <p class="flex gap-2 text-sm text-text-1" data-testid="secret-key-warning">
            <span class="i-lucide-triangle-alert mt-0.5 shrink-0 text-danger"></span>
            <span>Anyone with your secret key controls your account: they can open, change and delete your files. Never share it, and never paste it into a site you do not trust.</span>
          </p>
          {#if revealedSecretKey}
            <div
              class="rounded bg-surface-1 p-2 font-mono text-xs text-text-1 break-all select-all"
              data-testid="secret-key-value"
            >
              {revealedSecretKey}
            </div>
            <div class="flex flex-wrap gap-2">
              <CopyButton
                text={revealedSecretKey}
                label="Copy secret key"
                copiedLabel="Copied"
                class="btn-ghost flex items-center gap-2 text-sm"
                iconClass="i-lucide-copy"
                copiedIconClass="i-lucide-check text-success"
                testId="copy-secret-key"
              />
              <button
                type="button"
                class="btn-ghost flex items-center gap-2 text-sm"
                onclick={hideSecretKey}
                data-testid="hide-secret-key"
              >
                <span class="i-lucide-eye-off"></span>
                <span>Hide</span>
              </button>
            </div>
          {:else}
            <button
              type="button"
              class="btn-ghost flex items-center gap-2 text-sm"
              onclick={revealSecretKey}
              data-testid="reveal-secret-key"
            >
              <span class="i-lucide-eye"></span>
              <span>Show secret key</span>
            </button>
          {/if}
        </div>
      {:else}
        <p class="bg-surface-2 rounded p-3 text-sm text-text-3" data-testid="secret-key-elsewhere">
          Your secret key is kept by your browser extension or signer app, not by Drive.
        </p>
      {/if}
    </section>
  {/if}
</div>
