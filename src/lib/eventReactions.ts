export const DEFAULT_EVENT_REACTION_EMOJIS = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const;

export interface EventReactionRecord {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
}

export interface EventReactionSummary {
  emoji: string;
  count: number;
  reactorPubkeys: string[];
}

const DEFAULT_REACTION_ORDER: Map<string, number> = new Map(
  DEFAULT_EVENT_REACTION_EMOJIS.map((emoji, index) => [emoji, index]),
);

export function normalizeEventReactionContent(content?: string | null): string | null {
  const normalized = content?.trim();
  return normalized ? normalized : null;
}

export function isNewerEventReaction(
  candidate: Pick<EventReactionRecord, 'created_at' | 'id'>,
  current?: Pick<EventReactionRecord, 'created_at' | 'id'> | null,
): boolean {
  if (!current) {
    return true;
  }

  if (candidate.created_at !== current.created_at) {
    return candidate.created_at >= current.created_at;
  }

  return candidate.id >= current.id;
}

export function summarizeEventReactions(events: EventReactionRecord[]): EventReactionSummary[] {
  const latestByAuthorEmoji = new Map<string, EventReactionRecord>();

  for (const event of events) {
    const emoji = normalizeEventReactionContent(event.content);
    if (!emoji) {
      continue;
    }

    const authorPubkey = event.pubkey.trim();
    if (!authorPubkey) {
      continue;
    }

    const dedupeKey = `${authorPubkey}:${emoji}`;
    const current = latestByAuthorEmoji.get(dedupeKey);
    if (isNewerEventReaction(event, current)) {
      latestByAuthorEmoji.set(dedupeKey, { ...event, pubkey: authorPubkey, content: emoji });
    }
  }

  const summaryByEmoji = new Map<string, Set<string>>();
  for (const event of latestByAuthorEmoji.values()) {
    const reactors = summaryByEmoji.get(event.content) ?? new Set<string>();
    reactors.add(event.pubkey);
    summaryByEmoji.set(event.content, reactors);
  }

  return [...summaryByEmoji.entries()]
    .map(([emoji, reactors]) => ({
      emoji,
      count: reactors.size,
      reactorPubkeys: [...reactors].sort(),
    }))
    .sort((a, b) => {
      const aOrder = DEFAULT_REACTION_ORDER.get(a.emoji);
      const bOrder = DEFAULT_REACTION_ORDER.get(b.emoji);

      if (aOrder !== undefined || bOrder !== undefined) {
        if (aOrder === undefined) return 1;
        if (bOrder === undefined) return -1;
        return aOrder - bOrder;
      }

      return a.emoji.localeCompare(b.emoji);
    });
}
