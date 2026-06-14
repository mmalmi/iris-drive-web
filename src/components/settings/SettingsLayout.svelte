<script lang="ts">
  import { currentPath, navigate } from '../../lib/router.svelte';
  import StorageSettings from './StorageSettings.svelte';
  import AppSettings from './AppSettings.svelte';
  import P2PSettings from './P2PSettings.svelte';
  import ServersSettings from './ServersSettings.svelte';
  import TransportUsageSettings from './TransportUsageSettings.svelte';

  const tabs = [
    {
      id: 'app',
      label: 'App',
      icon: 'i-lucide-settings-2',
      activeRowClass: 'bg-accent/8',
      iconFrameClass: 'bg-accent/12 text-accent ring-1 ring-accent/20',
    },
    {
      id: 'storage',
      label: 'Storage',
      icon: 'i-lucide-hard-drive',
      activeRowClass: 'bg-amber-500/10',
      iconFrameClass: 'bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/20',
    },
    {
      id: 'network',
      label: 'Network',
      icon: 'i-lucide-server',
      activeRowClass: 'bg-sky-500/8',
      iconFrameClass: 'bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20',
    },
  ] as const satisfies ReadonlyArray<{
    id: string;
    label: string;
    icon: string;
    activeRowClass: string;
    iconFrameClass: string;
  }>;

  type TabId = (typeof tabs)[number]['id'];
  const networkSections = [
    {
      id: 'traffic',
      label: 'Traffic',
      description: 'Transferred totals grouped by transport.',
    },
    {
      id: 'servers',
      label: 'Servers',
      description: 'Relays and Blossom endpoints.',
    },
    {
      id: 'p2p',
      label: 'P2P',
      description: 'Connection pools and mesh peers.',
    },
  ] as const satisfies ReadonlyArray<{
    id: string;
    label: string;
    description: string;
  }>;

  const DEFAULT_TAB: TabId = 'app';
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

  let activeTab = $derived.by((): TabId => {
    const path = $currentPath;
    if (path === '/settings') return DEFAULT_TAB;
    if (path.startsWith('/settings/storage')) return 'storage';
    if (path.startsWith('/settings/network')) return 'network';
    if (path.startsWith('/settings/app')) return 'app';
    if (path.startsWith('/settings/servers')) return 'network';
    if (path.startsWith('/settings/p2p')) return 'network';
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
  let activeItem = $derived(tabs.find((tab) => tab.id === activeTab) ?? tabs[0]);
  let activeNetworkSectionItem = $derived(
    networkSections.find((section) => section.id === activeNetworkSection) ?? networkSections[0],
  );
</script>

<div class="flex min-h-0 flex-1 flex-col bg-surface-1 lg:flex-row">
  <aside
    class={`min-h-0 shrink-0 overflow-auto border-b border-surface-2 bg-surface-1 lg:w-[22rem] lg:border-b-0 lg:border-r ${isSettingsRootRoute ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'}`}
  >
    <div class="w-full px-4 pb-8 pt-6 lg:px-5 lg:py-6">
      <div class="mb-6">
        <h1 class="text-2xl font-semibold text-text-1">Settings</h1>
      </div>

      <div class="overflow-hidden rounded-2xl bg-surface-2 shadow-sm ring-1 ring-surface-3/80">
        {#each tabs as item, index (item.id)}
          <button
            data-testid={`settings-nav-${item.id}`}
            onclick={() => selectTab(item.id)}
            aria-current={activeTab === item.id ? 'page' : undefined}
            class={`relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${activeTab === item.id ? item.activeRowClass : 'hover:bg-surface-3/40'}`}
          >
            <span class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${item.iconFrameClass}`}>
              <span class={item.icon}></span>
            </span>
            <span class="min-w-0 flex-1 text-sm font-medium text-text-1">{item.label}</span>
            <span class="i-lucide-chevron-right shrink-0 text-base text-text-3"></span>
            {#if index < tabs.length - 1}
              <span class="absolute bottom-0 left-16 right-0 border-b border-surface-3/70"></span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
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

      {#if activeTab === 'app'}
        <AppSettings />
      {:else if activeTab === 'storage'}
        <StorageSettings />
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
