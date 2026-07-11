<script lang="ts">
  import { open as openCreateModal } from './Modals/CreateModal.svelte';

  interface Props {
    currentPath: string;
    homeHref: string;
  }

  let { currentPath, homeHref }: Props = $props();

  let myDriveActive = $derived(
    currentPath !== '/recent'
      && currentPath !== '/shared-with-me'
      && !currentPath.startsWith('/settings')
  );

  const navItems = [
    { href: '/recent', label: 'Recent', icon: 'i-lucide-clock-3' },
    { href: '/shared-with-me', label: 'Shared with me', icon: 'i-lucide-users' },
  ] as const;
</script>

<aside
  class="hidden md:flex w-60 shrink-0 flex-col px-3 pb-4 bg-surface-1"
  aria-label="Drive navigation"
  data-testid="drive-sidebar"
>
  <button
    type="button"
    class="mt-2 mb-4 ml-1 flex h-14 w-28 items-center gap-3 rounded-2xl bg-surface-0 px-4 text-sm font-medium text-text-1 shadow-sm ring-1 ring-surface-2 transition hover:bg-surface-2 hover:shadow"
    aria-label="New"
    onclick={() => openCreateModal('folder')}
  >
    <span class="i-lucide-plus text-2xl"></span>
    <span>New</span>
  </button>

  <nav class="flex flex-col gap-1">
    <a
      href={homeHref}
      aria-current={myDriveActive ? 'page' : undefined}
      class="flex h-10 items-center gap-3 rounded-full px-4 text-sm no-underline transition-colors {myDriveActive ? 'bg-accent/12 text-accent font-medium' : 'text-text-2 hover:bg-surface-2'}"
    >
      <span class="i-lucide-hard-drive text-lg"></span>
      <span>My Drive</span>
    </a>
    {#each navItems as item (item.href)}
      <a
        href={`#${item.href}`}
        aria-current={currentPath === item.href ? 'page' : undefined}
        class="flex h-10 items-center gap-3 rounded-full px-4 text-sm no-underline transition-colors {currentPath === item.href ? 'bg-accent/12 text-accent font-medium' : 'text-text-2 hover:bg-surface-2'}"
      >
        <span class={`${item.icon} text-lg`}></span>
        <span>{item.label}</span>
      </a>
    {/each}
  </nav>

  <div class="mt-auto pt-4 border-t border-surface-2">
    <a
      href="#/settings/storage"
      class="flex h-10 items-center gap-3 rounded-full px-4 text-sm text-text-2 no-underline transition-colors hover:bg-surface-2"
    >
      <span class="i-lucide-database text-lg"></span>
      <span>Storage</span>
    </a>
    <a
      href="#/settings"
      class="flex h-10 items-center gap-3 rounded-full px-4 text-sm text-text-2 no-underline transition-colors hover:bg-surface-2"
    >
      <span class="i-lucide-settings text-lg"></span>
      <span>Settings</span>
    </a>
  </div>
</aside>
