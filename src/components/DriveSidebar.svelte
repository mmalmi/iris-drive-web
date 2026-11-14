<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { isEditableDriveRouteScope } from '../drive/profileRoute';
  import { nostrStore } from '../nostr';
  import { routeStore } from '../stores';
  import { buildRouteUrl } from '../actions';
  import { isDocumentFolderName } from '../lib/documentNames';
  import { DRIVE_FOOTER_PLACES, drivePlaces } from '../lib/drivePlaces';
  import NewMenu from './NewMenu.svelte';

  interface Props {
    currentPath: string;
    homeHref: string;
    /** Icons with short names under them, for windows without room for the full sidebar. */
    rail?: boolean;
  }

  let { currentPath, homeHref, rail = false }: Props = $props();

  let route = $derived($routeStore);
  let places = $derived(drivePlaces(currentPath, homeHref, $acceptedShares));

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
</script>

{#snippet railLink(href: string, label: string, short: string, icon: string, active: boolean)}
  <a
    {href}
    aria-label={label}
    title={label}
    aria-current={active ? 'page' : undefined}
    class="group flex flex-col items-center gap-1 py-1 text-xs no-underline {active ? 'text-text-1 font-medium' : 'text-text-2'}"
  >
    <span class="flex h-8 w-14 items-center justify-center rounded-full transition-colors {active ? 'bg-accent/15 text-accent' : 'group-hover:bg-surface-2'}">
      <span class="{icon} text-xl"></span>
    </span>
    <span>{short}</span>
  </a>
{/snippet}

{#snippet fullLink(href: string, label: string, icon: string, active: boolean)}
  <a
    {href}
    aria-current={active ? 'page' : undefined}
    class="flex h-10 items-center gap-3 rounded-full px-4 text-sm no-underline transition-colors {active ? 'bg-accent/12 text-accent font-medium' : 'text-text-2 hover:bg-surface-2'}"
  >
    <span class="{icon} text-lg"></span>
    <span>{label}</span>
  </a>
{/snippet}

<aside
  class="hidden md:flex shrink-0 flex-col pb-4 bg-surface-1 {rail ? 'w-20 items-center px-1' : 'w-60 px-3'}"
  aria-label="Drive navigation"
  data-testid="drive-sidebar"
  data-rail={rail ? '' : undefined}
>
  {#if newTarget !== undefined}
    <NewMenu variant={rail ? 'rail' : 'sidebar'} goTo={newTarget} class="mt-2 mb-4 {rail ? '' : 'ml-1 self-start'}" />
  {:else}
    <!-- Keeps the places below where they were. -->
    <div class="mt-2 mb-4 h-14 shrink-0"></div>
  {/if}

  <nav class="flex flex-col {rail ? 'gap-3' : 'gap-1'}">
    {#each places as place (place.href)}
      {#if rail}
        {@render railLink(place.href, place.label, place.short, place.icon, place.active)}
      {:else}
        {@render fullLink(place.href, place.label, place.icon, place.active)}
      {/if}
    {/each}
  </nav>

  <div class="mt-auto pt-4 border-t border-surface-2 flex flex-col {rail ? 'gap-3 self-stretch items-center' : ''}">
    {#each DRIVE_FOOTER_PLACES as place (place.href)}
      {#if rail}
        {@render railLink(place.href, place.label, place.label, place.icon, false)}
      {:else}
        {@render fullLink(place.href, place.label, place.icon, false)}
      {/if}
    {/each}
  </div>
</aside>
