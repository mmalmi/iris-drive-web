<script lang="ts">
  /**
   * Settings, in the order a person needs them: their account, what this
   * device keeps, where else the Drive is kept, and what the app is. Everything about how Drive connects and
   * the keys behind the account waits under Advanced, closed until asked for.
   */
  import { currentPath, navigate } from '../../lib/router.svelte';
  import AccountSettings from './AccountSettings.svelte';
  import StorageSettings from './StorageSettings.svelte';
  import AboutSettings from './AboutSettings.svelte';
  import KeysSettings from './KeysSettings.svelte';
  import DeveloperSettings from './DeveloperSettings.svelte';
  import P2PSettings from './P2PSettings.svelte';
  import ServersSettings from './ServersSettings.svelte';
  import TransportUsageSettings from './TransportUsageSettings.svelte';

  let { onShortcuts }: { onShortcuts: () => void } = $props();

  interface SettingsTab {
    id: string;
    label: string;
    icon: string;
    activeRowClass: string;
    iconFrameClass: string;
  }

  const mainTabs = [
    {
      id: 'account',
      label: 'Account',
      icon: 'i-lucide-user-round',
      activeRowClass: 'bg-emerald-500/10',
      iconFrameClass: 'bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/20',
    },
    {
      id: 'storage',
      label: 'Storage',
      icon: 'i-lucide-hard-drive',
      activeRowClass: 'bg-amber-500/10',
      iconFrameClass: 'bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/20',
    },
    {
      id: 'about',
      label: 'About',
      icon: 'i-lucide-info',
      activeRowClass: 'bg-accent/8',
      iconFrameClass: 'bg-accent/12 text-accent ring-1 ring-accent/20',
    },
    {
      id: 'help',
      label: 'Help',
      icon: 'i-lucide-circle-help',
      activeRowClass: 'bg-accent/8',
      iconFrameClass: 'bg-accent/12 text-accent ring-1 ring-accent/20',
    },
  ] as const satisfies ReadonlyArray<SettingsTab>;

  const advancedTabs = [
    {
      id: 'network',
      label: 'Network',
      icon: 'i-lucide-server',
      activeRowClass: 'bg-sky-500/8',
      iconFrameClass: 'bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20',
    },
    {
      id: 'keys',
      label: 'Keys',
      icon: 'i-lucide-key-round',
      activeRowClass: 'bg-rose-500/8',
      iconFrameClass: 'bg-rose-500/12 text-rose-500 ring-1 ring-rose-500/20',
    },
    {
      id: 'developer',
      label: 'Developer',
      icon: 'i-lucide-code',
      activeRowClass: 'bg-violet-500/8',
      iconFrameClass: 'bg-violet-500/12 text-violet-500 ring-1 ring-violet-500/20',
    },
  ] as const satisfies ReadonlyArray<SettingsTab>;

  const tabs = [...mainTabs, ...advancedTabs];
  type TabId = (typeof tabs)[number]['id'];
  const advancedTabIds = new Set<TabId>(advancedTabs.map((tab) => tab.id));

  const networkSections = [
    {
      id: 'traffic',
      label: 'Usage',
      description: 'What this device has sent and received.',
    },
    {
      id: 'servers',
      label: 'Servers',
      description: 'Relays carry messages between devices. File servers keep copies of files.',
    },
    {
      id: 'p2p',
      label: 'Connections',
      description: 'Devices this one is connected to directly.',
    },
  ] as const satisfies ReadonlyArray<{
    id: string;
    label: string;
    description: string;
  }>;

  const DEFAULT_TAB: TabId = 'account';
  const DEFAULT_NETWORK_SECTION = 'traffic';
  type NetworkSectionId = (typeof networkSections)[number]['id'];

  function networkSectionPath(id: NetworkSectionId) {
    return `/settings/network/${id}`;
  }

  function selectTab(id: TabId) {
    if (id === 'network') {
      navigate(networkSectionPath(DEFAULT_NETWORK_SECTION));
      return;
    }
    navigate(`/settings/${id}`);
  }

  function selectNetworkSection(id: NetworkSectionId) {
    navigate(networkSectionPath(id));
  }

  function openSettingsIndex() {
    navigate('/settings');
  }

  // Older addresses still land where their content now lives.
  let activeTab = $derived.by((): TabId => {
    const path = $currentPath;
    if (path === '/settings') return DEFAULT_TAB;
    if (path.startsWith('/settings/account')) return 'account';
    if (path.startsWith('/settings/user') || path.startsWith('/settings/identity')) return 'account';
    if (path.startsWith('/settings/app')) return 'account';
    if (path.startsWith('/settings/storage')) return 'storage';
    if (path.startsWith('/settings/backup')) return 'storage';
    if (path.startsWith('/settings/about')) return 'about';
    if (path === '/settings/help') return 'help';
    if (path.startsWith('/settings/network')) return 'network';
    if (path.startsWith('/settings/servers')) return 'network';
    if (path.startsWith('/settings/p2p')) return 'network';
    if (path.startsWith('/settings/keys')) return 'keys';
    if (path.startsWith('/settings/developer')) return 'developer';
    return DEFAULT_TAB;
  });

  let activeNetworkSection = $derived.by((): NetworkSectionId => {
    const path = $currentPath;
    if (path.startsWith('/settings/servers')) return 'servers';
    if (path.startsWith('/settings/p2p')) return 'p2p';
    if (path.startsWith('/settings/network/servers')) return 'servers';
    if (path.startsWith('/settings/network/p2p')) return 'p2p';
    if (path.startsWith('/settings/network/traffic')) return 'traffic';
    return DEFAULT_NETWORK_SECTION;
  });

  let isSettingsRootRoute = $derived($currentPath === '/settings');
  let activeIsAdvanced = $derived(advancedTabIds.has(activeTab));
  let activeItem = $derived(tabs.find((tab) => tab.id === activeTab) ?? tabs[0]);
  let activeNetworkSectionItem = $derived(
    networkSections.find((section) => section.id === activeNetworkSection) ?? networkSections[0],
  );

  // Closed until asked for, and open whenever one of its pages is showing.
  let advancedOpen = $state(false);
  $effect(() => {
    if (activeIsAdvanced) advancedOpen = true;
  });
</script>

{#snippet navRow(item: SettingsTab, last: boolean)}
  <button
    data-testid={`settings-nav-${item.id}`}
    onclick={() => selectTab(item.id as TabId)}
    aria-current={activeTab === item.id ? 'page' : undefined}
    class={`relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${activeTab === item.id ? item.activeRowClass : 'hover:bg-surface-3/40'}`}
  >
    <span class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${item.iconFrameClass}`}>
      <span class={item.icon}></span>
    </span>
    <span class="min-w-0 flex-1 text-sm font-medium text-text-1">{item.label}</span>
    <span class="i-lucide-chevron-right shrink-0 text-base text-text-3"></span>
    {#if !last}
      <span class="absolute bottom-0 left-16 right-0 border-b border-surface-3/70"></span>
    {/if}
  </button>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col bg-surface-1 lg:flex-row" data-testid="settings-page">
  <aside
    class={`min-h-0 shrink-0 overflow-auto border-b border-surface-2 bg-surface-1 lg:w-[22rem] lg:border-b-0 lg:border-r ${isSettingsRootRoute ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'}`}
  >
    <nav class="w-full px-4 pb-8 pt-6 lg:px-5 lg:py-6" aria-label="Settings">
      <div class="mb-6">
        <h1 class="text-2xl font-semibold text-text-1">Settings</h1>
      </div>

      <div class="overflow-hidden rounded-2xl bg-surface-2 shadow-sm ring-1 ring-surface-3/80">
        {#each mainTabs as item, index (item.id)}
          {@render navRow(item, index === mainTabs.length - 1)}
        {/each}
      </div>

      <div class="mt-6 overflow-hidden rounded-2xl bg-surface-2 shadow-sm ring-1 ring-surface-3/80">
        <button
          type="button"
          class="relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-3/40"
          aria-label="Advanced"
          aria-describedby="settings-advanced-hint"
          aria-expanded={advancedOpen}
          aria-controls="settings-advanced-items"
          onclick={() => (advancedOpen = !advancedOpen)}
          data-testid="settings-advanced-toggle"
        >
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-text-2 ring-1 ring-surface-3">
            <span class="i-lucide-sliders-horizontal"></span>
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-text-1">Advanced</span>
            <span id="settings-advanced-hint" class="block truncate text-xs text-text-3">Network, keys, developer</span>
          </span>
          <span class={`i-lucide-chevron-down shrink-0 text-base text-text-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}></span>
          {#if advancedOpen}
            <span class="absolute bottom-0 left-16 right-0 border-b border-surface-3/70"></span>
          {/if}
        </button>
        {#if advancedOpen}
          <div id="settings-advanced-items" data-testid="settings-advanced-items">
            {#each advancedTabs as item, index (item.id)}
              {@render navRow(item, index === advancedTabs.length - 1)}
            {/each}
          </div>
        {/if}
      </div>
    </nav>
  </aside>

  <section class={`min-w-0 flex-1 overflow-auto ${isSettingsRootRoute ? 'hidden lg:block' : 'block'}`}>
    <div class="w-full px-4 pb-8 pt-6 lg:px-8 lg:py-8">
      <div class="mb-6 lg:hidden">
        <button
          class="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-3"
          onclick={openSettingsIndex}
        >
          <span class="i-lucide-chevron-left text-base"></span>
          <span>Settings</span>
        </button>
      </div>

      <div class="mb-6">
        {#if activeIsAdvanced}
          <p class="mb-1 text-xs font-medium uppercase tracking-wide text-text-3">Advanced</p>
        {/if}
        <h2 class="text-2xl font-semibold text-text-1">{activeItem.label}</h2>
        {#if activeTab === 'network'}
          <p class="mt-1 text-sm text-text-3">{activeNetworkSectionItem.description}</p>
        {/if}
      </div>

      {#if activeTab === 'network'}
        <div class="mb-6 flex flex-wrap gap-2">
          {#each networkSections as section (section.id)}
            <button
              data-testid={`settings-network-${section.id}`}
              onclick={() => selectNetworkSection(section.id)}
              aria-current={activeNetworkSection === section.id ? 'page' : undefined}
              class={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${activeNetworkSection === section.id ? 'bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20' : 'bg-surface-2 text-text-2 hover:bg-surface-3'}`}
            >
              {section.label}
            </button>
          {/each}
        </div>
      {/if}

      {#if activeTab === 'account'}
        <AccountSettings />
      {:else if activeTab === 'storage'}
        <StorageSettings />
      {:else if activeTab === 'about'}
        <AboutSettings />
      {:else if activeTab === 'help'}
        {#await import('./HelpSettings.svelte') then { default: HelpSettings }}
          <HelpSettings {onShortcuts} />
        {/await}
      {:else if activeTab === 'keys'}
        <KeysSettings />
      {:else if activeTab === 'developer'}
        <DeveloperSettings />
      {:else if activeNetworkSection === 'traffic'}
        <TransportUsageSettings embedded={true} />
      {:else if activeNetworkSection === 'servers'}
        <ServersSettings embedded={true} />
      {:else}
        <P2PSettings embedded={true} />
      {/if}
    </div>
  </section>
</div>
