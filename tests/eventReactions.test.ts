import { describe, expect, it } from 'vitest';
import {
  isNewerEventReaction,
  normalizeEventReactionContent,
  summarizeEventReactions,
} from '../src/lib/eventReactions';

describe('event reactions helpers', () => {
  it('normalizes blank reaction content away', () => {
    expect(normalizeEventReactionContent('  ')).toBeNull();
    expect(normalizeEventReactionContent(' 👍 ')).toBe('👍');
  });

  it('prefers the latest reaction for the same author and emoji', () => {
    expect(isNewerEventReaction(
      { id: 'b', created_at: 10 },
      { id: 'a', created_at: 10 },
    )).toBe(true);

    const summaries = summarizeEventReactions([
      { id: '1', pubkey: 'a'.repeat(64), content: '👍', created_at: 1 },
      { id: '2', pubkey: 'a'.repeat(64), content: '👍', created_at: 2 },
      { id: '3', pubkey: 'b'.repeat(64), content: '👍', created_at: 3 },
    ]);

    expect(summaries).toEqual([
      {
        emoji: '👍',
        count: 2,
        reactorPubkeys: ['a'.repeat(64), 'b'.repeat(64)],
      },
    ]);
  });

  it('separates different emojis from the same author and keeps github-style ordering', () => {
    const summaries = summarizeEventReactions([
      { id: '1', pubkey: 'b'.repeat(64), content: '🚀', created_at: 1 },
      { id: '2', pubkey: 'a'.repeat(64), content: '🎉', created_at: 1 },
      { id: '3', pubkey: 'a'.repeat(64), content: '👍', created_at: 1 },
      { id: '4', pubkey: 'c'.repeat(64), content: '🧪', created_at: 1 },
    ]);

    expect(summaries.map(summary => summary.emoji)).toEqual(['👍', '🎉', '🚀', '🧪']);
  });
});
