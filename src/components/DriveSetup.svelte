<script lang="ts">
  import type { Snippet } from 'svelte';
  import UsersPage from './UsersPage.svelte';

  interface Props {
    initialOwnerInput?: string;
    /** Shown above the choices, to say why the person is being asked. */
    children?: Snippet;
  }

  let { initialOwnerInput = '', children }: Props = $props();
  let hasInitialDeviceLink = $derived(Boolean(initialOwnerInput.trim()));
</script>

<div class="flex flex-1 items-center justify-center px-4 py-8 bg-surface-0" data-testid="drive-setup">
  <section class="w-full max-w-96 flex flex-col gap-6">
    {@render children?.()}
    <UsersPage
      mode={hasInitialDeviceLink ? 'existing' : 'list'}
      embedded={true}
      initialDeviceLink={initialOwnerInput}
    />

    <a
      class="text-center text-sm text-text-3 hover:text-text-1"
      href="https://getdrive.iris.to/"
      target="_blank"
      rel="noreferrer"
    >
      Get native app
    </a>
  </section>
</div>
