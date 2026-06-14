import type { NDKFilter } from 'ndk';
import { writable, type Readable } from 'svelte/store';
import { ndk, NDKEvent, nostrStore } from '../nostr';
import {
  isNewerEventReaction,
  normalizeEventReactionContent,
  summarizeEventReactions,
  type EventReactionSummary,
} from '../lib/eventReactions';
import { publishEventWithFallback } from '../lib/nostrPublish';
import { KIND_REACTION } from '../utils/constants';

export interface EventReactionsState {
  items: EventReactionSummary[];
  loading: boolean;
  error: string | null;
  pendingEmoji: string | null;
}

function createEmptyEventReactionsState(loading: boolean): EventReactionsState {
  return {
    items: [],
    loading,
    error: null,
    pendingEmoji: null,
  };
}

function summarizeReactionEvents(events: Map<string, NDKEvent>): EventReactionSummary[] {
  return summarizeEventReactions(
    [...events.values()].flatMap((event) => {
      if (!event.id || !event.pubkey) {
        return [];
      }

      const emoji = normalizeEventReactionContent(event.content);
      if (!emoji) {
        return [];
      }

      return [{
        id: event.id,
        pubkey: event.pubkey,
        content: emoji,
        created_at: event.created_at || 0,
      }];
    }),
  );
}

function findLatestUserReaction(
  events: Map<string, NDKEvent>,
  pubkey: string,
  emoji: string,
): NDKEvent | null {
  let latest: NDKEvent | null = null;

  for (const event of events.values()) {
    if (!event.id || event.pubkey !== pubkey) {
      continue;
    }

    if (normalizeEventReactionContent(event.content) !== emoji) {
      continue;
    }

    if (!latest || isNewerEventReaction(
      { id: event.id, created_at: event.created_at || 0 },
      { id: latest.id!, created_at: latest.created_at || 0 },
    )) {
      latest = event;
    }
  }

  return latest;
}

export function createEventReactionsStore(
  targetEventId: string | null,
  targetKind: number,
  targetAuthorPubkey: string | null,
): Readable<EventReactionsState> & {
  toggleReaction: (emoji: string) => Promise<boolean>;
  destroy: () => void;
} {
  const { subscribe, set, update } = writable<EventReactionsState>(
    createEmptyEventReactionsState(!!targetEventId),
  );
  const reactionEvents = new Map<string, NDKEvent>();

  function rebuildState(overrides: Partial<EventReactionsState> = {}) {
    update((state) => ({
      ...state,
      items: summarizeReactionEvents(reactionEvents),
      ...overrides,
    }));
  }

  if (!targetEventId) {
    set(createEmptyEventReactionsState(false));
    return {
      subscribe,
      toggleReaction: async () => false,
      destroy: () => {},
    };
  }

  let destroyed = false;
  let initialLoadFinished = false;
  const initialLoadTimeout = setTimeout(() => {
    if (!destroyed && !initialLoadFinished) {
      rebuildState({ loading: false });
    }
  }, 3000);

  const filter: NDKFilter = {
    kinds: [KIND_REACTION],
    '#e': [targetEventId],
  };
  const sub = ndk.subscribe(filter, { closeOnEose: false });

  sub.on('event', (event: NDKEvent) => {
    if (!event.id || !event.pubkey) {
      return;
    }

    const emoji = normalizeEventReactionContent(event.content);
    if (!emoji) {
      return;
    }

    reactionEvents.set(event.id, event);
    rebuildState({ error: null });
  });

  sub.on('eose', () => {
    initialLoadFinished = true;
    clearTimeout(initialLoadTimeout);
    rebuildState({ loading: false });
  });

  async function toggleReaction(emoji: string): Promise<boolean> {
    const normalizedEmoji = normalizeEventReactionContent(emoji);
    const currentUserPubkey = nostrStore.getState().pubkey;

    if (!normalizedEmoji || !currentUserPubkey || !targetAuthorPubkey || !ndk.signer) {
      return false;
    }

    rebuildState({ pendingEmoji: normalizedEmoji, error: null });

    try {
      const existingReaction = findLatestUserReaction(reactionEvents, currentUserPubkey, normalizedEmoji);

      if (existingReaction?.id) {
        const deletion = await existingReaction.delete('Removed reaction', false);
        await publishEventWithFallback(deletion);
        reactionEvents.delete(existingReaction.id);
      } else {
        const targetEvent = new NDKEvent(ndk, {
          id: targetEventId ?? undefined,
          kind: targetKind,
          pubkey: targetAuthorPubkey,
        });
        const reaction = await targetEvent.react(normalizedEmoji as Parameters<typeof targetEvent.react>[0], false);
        await publishEventWithFallback(reaction);
        if (reaction.id) {
          reactionEvents.set(reaction.id, reaction);
        }
      }

      rebuildState({ pendingEmoji: null, error: null });
      return true;
    } catch (err) {
      rebuildState({
        pendingEmoji: null,
        error: err instanceof Error ? err.message : 'Failed to update reaction',
      });
      return false;
    }
  }

  function destroy() {
    destroyed = true;
    clearTimeout(initialLoadTimeout);
    sub.stop();
  }

  return {
    subscribe,
    toggleReaction,
    destroy,
  };
}
