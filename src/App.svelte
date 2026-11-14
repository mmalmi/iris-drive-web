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
  import DriveTabs from './components/DriveTabs.svelte';
  import Toast from './components/Toast.svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { chooseSidebar, sidebarChoice } from './stores/sidebar';
  import { isViewingFileStore, routeStore } from './stores';
  import { isDocumentFolderName } from './lib/documentNames';
  import Router from './components/Router.svelte';
  import { currentPath, initRouter } from './lib/router.svelte';
  import { settingsStore } from './stores/settings';
  import { nostrStore } from './nostr';
  import { activeDriveRootPath } from './drive/profileRoute';
  import { acceptedShares } from './drive/shareLibrary';
  import { PENDING_JOIN_KEY, PENDING_OPEN_KEY } from './drive/sharePeople';
  import { navigate } from './lib/router.svelte';

  // Modal components
  import CreateModal from './components/Modals/CreateModal.svelte';
  import RenameModal from './components/Modals/RenameModal.svelte';
  import MoveModal from './components/Modals/MoveModal.svelte';
  import ForkModal from './components/Modals/ForkModal.svelte';
  import ExtractModal from './components/Modals/ExtractModal.svelte';
  import GitignoreModal from './components/Modals/GitignoreModal.svelte';
  import ShareModal from './components/Modals/ShareModal.svelte';
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
      '/share-join',
      '/users',
    ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });
  // The full sidebar where the window has room for it, a rail of icons where
  // it has not, until someone chooses one with the menu button.
  const wide = new MediaQuery('min-width: 1280px');
  let sidebarRail = $derived(($sidebarChoice ?? (wide.current ? 'full' : 'rail')) === 'rail');
  // A phone's places, below lists of files; an open document or file has the screen to itself.
  let showDriveTabs = $derived(showDriveSidebar && !$isViewingFileStore && !$routeStore.path.some(isDocumentFolderName));

  onMount(() => {
    initRouter();
    // A file dropped where nothing takes it would otherwise open in place of the app.
    const keepPage = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', keepPage);
    window.addEventListener('drop', keepPage);
    return () => {
      window.removeEventListener('dragover', keepPage);
      window.removeEventListener('drop', keepPage);
    };
  });

  // A join link or shared folder opened before signing in: go back to it once there is an account.
  $effect(() => {
    if (homePath === '/' || $currentPath.startsWith('/share-join/') || $currentPath.startsWith('/users')) return;
    try {
      const pendingJoin = sessionStorage.getItem(PENDING_JOIN_KEY);
      const pendingOpen = sessionStorage.getItem(PENDING_OPEN_KEY);
      sessionStorage.removeItem(PENDING_JOIN_KEY);
      sessionStorage.removeItem(PENDING_OPEN_KEY);
      if (pendingJoin) navigate(`/share-join/${pendingJoin}`);
      else if (pendingOpen && pendingOpen !== $currentPath) navigate(pendingOpen);
    } catch {
      // No session storage: the visitor opens the link again.
    }
  });

  // Join links this device handed out are answered for as long as Drive is open.
  let stopJoinWatch: (() => void) | null = null;
  $effect(() => {
    if (stopJoinWatch || !$acceptedShares.some((record) => record.join_links?.length)) return;
    stopJoinWatch = () => {};
    void import('./drive/shareOwner').then(({ watchJoinRequests }) => {
      stopJoinWatch = watchJoinRequests();
    });
  });

  // Folders people share with this account directly show up while Drive is open.
  let stopAddedWatch: (() => void) | null = null;
  $effect(() => {
    if (stopAddedWatch || !$nostrStore.isLoggedIn) return;
    stopAddedWatch = () => {};
    void import('./drive/shareJoin').then(({ watchSharesAddedToMe }) => {
      stopAddedWatch = watchSharesAddedToMe();
    });
  });
  // Items shared by link stay current while Drive is open on the device that shares them.
  let stopLinkWatch: (() => void) | null = null;
  $effect(() => {
    if (stopLinkWatch || !$nostrStore.isLoggedIn) return;
    stopLinkWatch = () => {};
    void import('./drive/linkShareSync').then(({ watchLinkShares }) => {
      stopLinkWatch = watchLinkShares();
    });
  });
  // This device says once that it belongs to its account, so people can add it to folders.
  $effect(() => {
    if (!$nostrStore.isLoggedIn || !$nostrStore.pubkey) return;
    void import('./drive/sharePersonLookup')
      .then(({ publishOwnShareAcceptance }) => publishOwnShareAcceptance())
      .catch((error) => console.warn('[share] Could not publish this device for sharing:', error));
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

<div class="h-full flex flex-col bg-surface-1" style:--drive-tabs-height={showDriveTabs ? '4rem' : undefined}>
  <Header>
    <div class="flex items-center shrink-0">
      {#if showDriveSidebar}
        <button
          type="button"
          class="hidden md:flex -ml-1 mr-2 h-10 w-10 items-center justify-center rounded-full text-text-2 hover:bg-surface-2"
          aria-label="Main menu"
          aria-expanded={!sidebarRail}
          title={sidebarRail ? 'Show the full menu' : 'Show icons only'}
          data-testid="sidebar-toggle"
          onclick={() => chooseSidebar(sidebarRail ? 'full' : 'rail')}
        >
          <span class="i-lucide-menu text-xl"></span>
        </button>
      {/if}
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
      <DriveSidebar currentPath={$currentPath} {homeHref} rail={sidebarRail} />
    {/if}
    <div class="flex-1 flex flex-col min-w-0 min-h-0 bg-surface-0 md:mr-2 md:mb-2 md:rounded-2xl md:overflow-hidden">
      <Router currentPath={$currentPath} />
    </div>
  </div>
  {#if showDriveTabs}
    <DriveTabs currentPath={$currentPath} {homeHref} />
  {/if}

  <!-- Modals -->
  <CreateModal />
  <RenameModal />
  <MoveModal />
  <ForkModal />
  <ExtractModal />
  <GitignoreModal />
  <ShareModal />
  <UnsavedChangesModal />
  <BlossomPushModal />
  <Toast />
</div>
