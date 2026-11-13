<script lang="ts">
  import { acceptedShares, isOwnShare } from '../drive/shareLibrary';
  import { isEditableDriveRouteScope } from '../drive/profileRoute';
  import { nostrStore } from '../nostr';
  import { routeStore } from '../stores';
  import { buildRouteUrl } from '../actions';
  import { isDocumentFolderName } from '../lib/documentNames';
  import NewMenu from './NewMenu.svelte';

  interface Props {
    currentPath: string;
    homeHref: string;
  }

  let { currentPath, homeHref }: Props = $props();

  let shareScope = $derived(currentPath.split('/').filter(Boolean)[0]);
  // A folder shared with this profile; one it shared itself stays under My Drive.
  let sharedFolderRoute = $derived($acceptedShares.some((record) => record.share_id === shareScope && !isOwnShare(record)));
  let route = $derived($routeStore);

  /**
   * Where New puts things: undefined in a folder only to read, where it is not
   * offered; null for the open folder; or the folder to open first: the one
   * around an open document, or My Drive from Recent and Shared with me.
   */
  let newTarget = $derived.by((): string | null | undefined => {
    if (route.isPermalink) return undefined;
    if (!route.treeName) return homeHref;
    const canEdit = !route.npub || route.npub === $nostrStore.npub
      || isEditableDriveRouteScope(route.npub, $nostrStore, $acceptedShares);
    if (!canEdit) return undefined;
    const documentAt = route.path.findIndex(isDocumentFolderName);
    if (documentAt < 0) return null;
    return `#${buildRouteUrl(route.npub, route.treeName, route.path.slice(0, documentAt), undefined, route.params.get('k'))}`;
  });
  let myDriveActive = $derived(!sharedFolderRoute &&
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
  {#if newTarget !== undefined}
    <NewMenu variant="sidebar" goTo={newTarget} class="mt-2 mb-4 ml-1 self-start" />
  {:else}
    <!-- Keeps the places below where they were. -->
    <div class="mt-2 mb-4 h-14 shrink-0"></div>
  {/if}

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
        aria-current={(currentPath === item.href || (item.href === '/shared-with-me' && sharedFolderRoute)) ? 'page' : undefined}
        class="flex h-10 items-center gap-3 rounded-full px-4 text-sm no-underline transition-colors {(currentPath === item.href || (item.href === '/shared-with-me' && sharedFolderRoute)) ? 'bg-accent/12 text-accent font-medium' : 'text-text-2 hover:bg-surface-2'}"
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
