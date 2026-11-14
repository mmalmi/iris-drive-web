<script lang="ts">
  import type { Snippet } from 'svelte';
  import UsersPage from './UsersPage.svelte';
  import { DRIVE_APP_DOWNLOAD_URL } from '../lib/appBrand';
  import { getRuntimeHtreeServerUrl } from '../lib/htreeRuntime';

  interface Props {
    initialOwnerInput?: string;
    /** Shown above the choices, to say why the person is being asked. */
    children?: Snippet;
  }

  let { initialOwnerInput = '', children }: Props = $props();
  let hasInitialDeviceLink = $derived(Boolean(initialOwnerInput.trim()));
  const inNativeApp = Boolean(getRuntimeHtreeServerUrl());
</script>

<div class="flex flex-1 items-center justify-center px-4 py-8 bg-surface-0" data-testid="drive-setup">
  <section class="w-full max-w-96 flex flex-col gap-6">
    {#if children}
      {@render children()}
    {:else}
      <header class="flex flex-col items-center gap-3 text-center" data-testid="drive-setup-intro">
        <img src="./iris-drive-icon.svg" alt="" class="w-14 h-14" />
        <h1 class="text-xl font-semibold text-text-1">Iris Drive</h1>
        <p class="text-sm text-text-2 max-w-72">Files, documents, spreadsheets and presentations, private and in sync on all your devices.</p>
      </header>
    {/if}
    <UsersPage
      mode={hasInitialDeviceLink ? 'existing' : 'list'}
      embedded={true}
      initialDeviceLink={initialOwnerInput}
    />

    {#if !children && !inNativeApp}
      <a
        class="text-center text-sm text-text-3 hover:text-text-1"
        href={DRIVE_APP_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
      >
        Get the Iris Drive app
      </a>
    {/if}
  </section>
</div>
