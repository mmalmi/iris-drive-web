import { describe, expect, it } from 'vitest';
import { resolvePublishLabels } from '@iris/hashtree-app/publishLabels';

describe('resolvePublishLabels', () => {
  it('preserves existing labels when callers omit them on republish', () => {
    expect(resolvePublishLabels({ currentLabels: ['git'] })).toEqual(['git']);
  });

  it('merges existing and explicit labels without duplicates', () => {
    expect(resolvePublishLabels({
      currentLabels: ['git'],
      explicitLabels: ['docs', 'git'],
    })).toEqual(['git', 'docs']);
  });

  it('returns undefined when no labels are available', () => {
    expect(resolvePublishLabels()).toBeUndefined();
  });
});
