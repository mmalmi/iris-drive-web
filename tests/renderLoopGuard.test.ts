import { describe, expect, it } from 'vitest';
import { formatRenderLoopFailures, isRenderLoopMessage } from '../e2e/renderLoopGuard';

describe('render loop guard', () => {
  it('matches Svelte update-depth loop errors', () => {
    expect(isRenderLoopMessage('effect_update_depth_exceeded\nMaximum update depth exceeded')).toBe(true);
    expect(isRenderLoopMessage('Maximum update depth exceeded')).toBe(true);
    expect(isRenderLoopMessage('Unhandled promise rejection')).toBe(false);
  });

  it('formats detected loop failures for test output', () => {
    expect(formatRenderLoopFailures(new Set([
      '[pageerror] /#/ effect_update_depth_exceeded',
    ]))).toBe(
      'Detected Svelte render/update loop:\n[pageerror] /#/ effect_update_depth_exceeded'
    );
  });
});
