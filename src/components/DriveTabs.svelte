<script lang="ts">
  /** Drive's places along the bottom of a phone's screen, where there is no sidebar. */
  import { acceptedShares } from '../drive/shareLibrary';
  import NewMenu from './NewMenu.svelte';
  import { newDestination } from '../stores/newDestination';
  import { drivePlaces } from '../lib/drivePlaces';

  let { currentPath, homeHref }: { currentPath: string; homeHref: string } = $props();

  let places = $derived(drivePlaces(currentPath, homeHref, $acceptedShares));
</script>

{#if $newDestination}
  <div class="phone-new sm:hidden">
    <NewMenu variant="phone" goTo={$newDestination.href} inMyDrive={$newDestination.inMyDrive} />
  </div>
{/if}

<nav
  class="md:hidden flex shrink-0 border-t border-surface-2 bg-surface-1 pb-[env(safe-area-inset-bottom)]"
  aria-label="Drive places"
  data-testid="drive-tabs"
>
  {#each places as place (place.href)}
    <a
      href={place.href}
      aria-label={place.label}
      aria-current={place.active ? 'page' : undefined}
      class="flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs no-underline {place.active ? 'text-text-1 font-medium' : 'text-text-2'}"
    >
      <span class="flex h-8 w-16 items-center justify-center rounded-full {place.active ? 'bg-accent/15 text-accent' : ''}">
        <span class="{place.icon} text-xl"></span>
      </span>
      <span>{place.short}</span>
    </a>
  {/each}
</nav>

<style>
  :global(body:has(.folder-selection-bar)) .phone-new { display: none; }
</style>
