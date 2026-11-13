<script lang="ts">
  /**
   * A person: what you share with each other here, and where to find them in
   * Iris. Shows what this device holds; their name fills in when it arrives.
   */
  import { fallbackIdentityName } from '@iris/svelte-ui/profile';
  import { nostrStore } from '../nostr';
  import { acceptedShares, type AcceptedShareRecord } from '../drive/shareLibrary';
  import { activeDriveRootPath, activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { npubPubkey, personOverview, sharedItemHref } from '../drive/people';
  import { documentKindInfo } from '../lib/documentNames';
  import { isNostrIdentityId } from '../utils/route';
  import { Avatar, Name } from './User';

  let { id }: { id: string } = $props();

  let known = $derived(isNostrIdentityId(id) || npubPubkey(id) !== null);
  let person = $derived(personOverview(id, $acceptedShares, activeNostrIdentityRootScope($nostrStore)));
  let pubkey = $derived(person.npub ? npubPubkey(person.npub) : null);
  let sections = $derived([
    { title: 'Shared with you', items: person.sharedWithYou, testId: 'person-shared-with-you' },
    { title: 'You share with them', items: person.youShare, testId: 'person-you-share' },
  ]);

  function itemIcon(record: AcceptedShareRecord): string {
    return documentKindInfo(record.folder.source_path.split('/').at(-1))?.icon ?? 'i-lucide-folder text-warning';
  }
</script>

<main class="flex-1 min-w-0 overflow-auto bg-surface-0" data-testid="person-page">
  {#if !known}
    <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-3">
      <span class="i-lucide-circle-help text-4xl"></span>
      Nothing to show here.
      <a class="btn-ghost no-underline" href="#{activeDriveRootPath($nostrStore)}">Go to My Drive</a>
    </div>
  {:else}
    <div class="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div class="flex items-center gap-4">
        {#if pubkey}
          <Avatar {pubkey} size={56} />
        {:else}
          <span class="i-lucide-circle-user-round text-5xl text-text-3 shrink-0"></span>
        {/if}
        <div class="min-w-0">
          <h1 class="text-xl font-semibold text-text-1 truncate" data-testid="person-name">
            {#if person.name}{person.name}{:else if pubkey}<Name {pubkey} />{:else}{fallbackIdentityName(id)}{/if}
          </h1>
          {#if person.npub}
            <div class="text-xs text-text-3 font-mono truncate">{person.npub}</div>
          {/if}
        </div>
      </div>

      {#if person.npub}
        <div class="flex flex-wrap gap-2">
          <a
            class="btn-ghost no-underline text-sm"
            href="https://iris.to/{person.npub}"
            target="_blank"
            rel="noreferrer"
            data-testid="person-iris-link"
          >
            <span class="i-lucide-external-link"></span>
            Open profile in Iris
          </a>
          <a
            class="btn-ghost no-underline text-sm"
            href="https://chat.iris.to/#/{person.npub}"
            target="_blank"
            rel="noreferrer"
            data-testid="person-chat-link"
          >
            <span class="i-lucide-message-circle"></span>
            Message in Iris Chat
          </a>
        </div>
      {/if}

      {#each sections as section (section.testId)}
        <section data-testid={section.testId}>
          <h2 class="text-xs font-medium text-text-3 uppercase tracking-wide mb-2">{section.title}</h2>
          {#if section.items.length === 0}
            <p class="text-sm text-text-3">Nothing yet</p>
          {:else}
            <div class="rounded-xl border border-surface-2 divide-y divide-surface-2 overflow-hidden">
              {#each section.items as record (record.share_id)}
                <a
                  class="flex items-center gap-3 px-4 py-3 no-underline text-text-1 hover:bg-surface-1"
                  href={sharedItemHref(record.share_id, record.folder.source_path)}
                  data-testid="person-item"
                >
                  <span class="shrink-0 {itemIcon(record)}"></span>
                  <span class="truncate">{record.folder.display_name}</span>
                </a>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</main>
