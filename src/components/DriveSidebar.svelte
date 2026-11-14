<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { newDestination } from '../stores/newDestination';
  import { DRIVE_FOOTER_PLACES, drivePlaces } from '../lib/drivePlaces';
  import NewMenu from './NewMenu.svelte';

  interface Props {
    currentPath: string;
    homeHref: string;
    /** Icons with short names under them, for windows without room for the full sidebar. */
    rail?: boolean;
    /**
     * Nobody has chosen, so the window's width decides. The width is then set
     * by CSS, which follows a resize at once, so what is beside the sidebar
     * does not move again a moment later when the script catches up.
     */
    auto?: boolean;
  }

  let { currentPath, homeHref, rail = false, auto = false }: Props = $props();

  let places = $derived(drivePlaces(currentPath, homeHref, $acceptedShares));
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
  class="hidden md:flex shrink-0 flex-col pb-4 bg-surface-1 {auto ? 'w-20 xl:w-60' : rail ? 'w-20' : 'w-60'} {rail ? 'items-center px-1' : 'px-3'}"
  aria-label="Drive navigation"
  data-testid="drive-sidebar"
  data-rail={rail ? '' : undefined}
>
  {#if $newDestination}
    <NewMenu variant={rail ? 'rail' : 'sidebar'} goTo={$newDestination.href} inMyDrive={$newDestination.inMyDrive} class="mt-2 mb-4 {rail ? '' : 'ml-1 self-start'}" />
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
