<script lang="ts">
  import { onMount } from 'svelte';
  import Logo from './components/Logo.svelte';
  import Header from './components/Header.svelte';
  import NostrLogin from './components/NostrLogin.svelte';
  import ConnectivityIndicator from './components/ConnectivityIndicator.svelte';
  import BandwidthIndicator from './components/BandwidthIndicator.svelte';
  import SearchInput from './components/SearchInput.svelte';
  import MobileSearch from './components/MobileSearch.svelte';
  import DriveSidebar from './components/DriveSidebar.svelte';
  import Toast from './components/Toast.svelte';
  import Router from './components/Router.svelte';
  import { currentPath, initRouter } from './lib/router.svelte';
  import { settingsStore } from './stores/settings';
  import { nostrStore } from './nostr';
  import { activeDriveRootPath } from './drive/profileRoute';

  // Modal components
  import CreateModal from './components/Modals/CreateModal.svelte';
  import RenameModal from './components/Modals/RenameModal.svelte';
  import ForkModal from './components/Modals/ForkModal.svelte';
  import ExtractModal from './components/Modals/ExtractModal.svelte';
  import GitignoreModal from './components/Modals/GitignoreModal.svelte';
  import ShareModal from './components/Modals/ShareModal.svelte';
  import CollaboratorsModal from './components/Modals/CollaboratorsModal.svelte';
  import UnsavedChangesModal from './components/Modals/UnsavedChangesModal.svelte';
  import BlossomPushModal from './components/Modals/BlossomPushModal.svelte';

  // Header display settings (default to true/false if not yet loaded)
  let showConnectivity = $derived($settingsStore.pools.showConnectivity ?? false);
  let showBandwidth = $derived($settingsStore.pools.showBandwidth ?? false);
  let homePath = $derived(activeDriveRootPath($nostrStore));
  let homeHref = $derived(`#${homePath}`);
  let showDriveSidebar = $derived.by(() => {
    if (!$nostrStore.isLoggedIn) return false;
    const path = $currentPath;
    return ![
      '/approve-device',
      '/settings',
      '/share',
      '/share-invite',
      '/users',
      '/wallet',
    ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });

  onMount(() => {
    initRouter();
  });

  function handleLogoClick(e: MouseEvent) {
    const isEmptyHomeHash = homePath === '/'
      && (window.location.hash === '' || window.location.hash === '#');
    if (window.location.hash === homeHref || isEmptyHomeHash) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
</script>

<div class="h-full flex flex-col bg-surface-1">
  <Header>
    <div class="flex items-center shrink-0">
      <a href={homeHref} onclick={handleLogoClick} class="no-underline" data-testid="home-link">
        <Logo />
      </a>
    </div>
    <div class="flex-1 hidden md:flex justify-center px-4">
      <SearchInput />
    </div>
    <div class="flex-1 md:hidden"></div>
    <div class="flex items-center gap-2 md:gap-3 shrink-0">
      <MobileSearch />
      {#if showBandwidth}
        <BandwidthIndicator />
      {/if}
      <ConnectivityIndicator showAlways={showConnectivity} />
      <NostrLogin />
    </div>
  </Header>

  <!-- Main area -->
  <div class="flex-1 flex min-h-0">
    {#if showDriveSidebar}
      <DriveSidebar currentPath={$currentPath} {homeHref} />
    {/if}
    <div class="flex-1 flex flex-col min-w-0 min-h-0 bg-surface-0 md:mr-2 md:mb-2 md:rounded-2xl md:overflow-hidden">
      <Router currentPath={$currentPath} />
    </div>
  </div>

  <!-- Modals -->
  <CreateModal />
  <RenameModal />
  <ForkModal />
  <ExtractModal />
  <GitignoreModal />
  <ShareModal />
  <CollaboratorsModal />
  <UnsavedChangesModal />
  <BlossomPushModal />
  <Toast />
</div>
