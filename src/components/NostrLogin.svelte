<script lang="ts">
  import { onMount } from 'svelte';
  import { navigate } from '../utils/navigate';
  import {
    nostrStore,
    loginWithExtension,
    loginWithNsec,
    generateNewKey,
    logout,
  } from '../nostr';
  import { isFilesApp } from '../appType';
  import { Avatar } from './User';

  let showNsec = $state(false);
  let nsecInput = $state('');
  let error = $state('');
  let menuOpen = $state(false);
  let menuRoot: HTMLDivElement | undefined = $state();

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let pubkey = $derived($nostrStore.pubkey);

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRoot?.contains(event.target as Node)) menuOpen = false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') menuOpen = false;
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  });

  function openRoute(path: string) {
    menuOpen = false;
    navigate(path);
  }

  function handleLogout() {
    menuOpen = false;
    logout();
    navigate('/');
  }

  async function handleExtensionLogin() {
    error = '';
    const success = await loginWithExtension();
    if (!success) {
      error = 'Extension login failed. Is a nostr extension installed?';
    }
  }

  async function handleNsecLogin() {
    error = '';
    if (!nsecInput.trim()) {
      error = 'Please enter an nsec';
      return;
    }
    const success = await loginWithNsec(nsecInput.trim());
    if (!success) {
      error = 'Invalid nsec';
    } else {
      nsecInput = '';
      showNsec = false;
    }
  }

  async function handleGenerate() {
    error = '';
    await generateNewKey();
  }
</script>

{#if isLoggedIn && pubkey}
  <div class="relative" bind:this={menuRoot}>
    <button
      onclick={() => (menuOpen = !menuOpen)}
      class="bg-transparent border-none cursor-pointer p-0"
      title="Account menu"
      aria-label="Open account menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-testid="header-user-avatar"
    >
      <Avatar pubkey={pubkey} size={36} />
    </button>

    {#if menuOpen}
      <div
        class="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl bg-surface-1 py-1 shadow-xl ring-1 ring-surface-3"
        role="menu"
        data-testid="account-menu"
      >
        <button
          class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-1 hover:bg-surface-2"
          role="menuitem"
          onclick={() => openRoute('/users')}
          data-testid="account-menu-users"
        >
          <span class="i-lucide-users"></span>
          <span>Users</span>
        </button>
        <button
          class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-1 hover:bg-surface-2"
          role="menuitem"
          onclick={() => openRoute('/settings')}
          data-testid="account-menu-settings"
        >
          <span class="i-lucide-settings"></span>
          <span>Settings</span>
        </button>
        <div class="my-1 border-t border-surface-3"></div>
        <button
          class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-danger hover:bg-danger/10"
          role="menuitem"
          onclick={handleLogout}
          data-testid="account-menu-logout"
        >
          <span class="i-lucide-log-out"></span>
          <span>Log out</span>
        </button>
      </div>
    {/if}
  </div>
{:else if isFilesApp()}
  <button
    onclick={() => navigate('/')}
    class="btn-circle btn-ghost"
    title="Set up profile"
    aria-label="Set up profile"
  >
    <span class="i-lucide-user-plus"></span>
  </button>
{:else}
  <div class="flex flex-col gap-2">
    <div class="flex gap-1 md:gap-2 flex-wrap">
      <button onclick={handleExtensionLogin} class="btn-success text-xs md:text-sm">
        <span class="hidden md:inline">Login (Extension)</span>
        <span class="md:hidden">Login</span>
      </button>

      <button
        onclick={() => (showNsec = !showNsec)}
        class="btn-ghost text-xs md:text-sm hidden md:block"
      >
        {showNsec ? 'Cancel' : 'nsec'}
      </button>

      <button onclick={handleGenerate} class="btn-ghost text-xs md:text-sm hidden md:block">
        New
      </button>
    </div>

    {#if showNsec}
      <div class="flex gap-2">
        <input
          type="password"
          bind:value={nsecInput}
          placeholder="nsec1..."
          class="flex-1 input text-sm"
        />
        <button onclick={handleNsecLogin} class="btn-success text-sm">
          Login
        </button>
      </div>
    {/if}

    {#if error}
      <p class="text-danger text-sm m-0">{error}</p>
    {/if}
  </div>
{/if}
