<script lang="ts">
  /**
   * Who wrote a comment: their name as their profile says, or as it was when
   * they wrote, while this browser has not found their profile.
   */
  import type { CommentAuthor } from '../../lib/sheets/comments';
  import { createIdentityProfileNameStore } from '../../stores/identityProfile';

  interface Props {
    author: CommentAuthor;
  }
  let { author }: Props = $props();

  let store = $derived(createIdentityProfileNameStore(author.profile, author.pubkey));
  let state = $derived($store);
  let name = $derived(state.name !== state.fallbackName ? state.name : author.name || state.name);
</script>

<span class="name" title={name}>{name}</span>

<style>
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: rgb(var(--text-1));
  }
</style>
