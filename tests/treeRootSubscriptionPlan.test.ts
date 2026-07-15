import { describe, expect, it } from 'vitest';
import {
  getTreeRootSubscriptionPlan,
  shouldStartTreeRootSubscription,
} from '../src/lib/treeRootSubscriptionPlan';

describe('getTreeRootSubscriptionPlan', () => {
  it('keeps the exact resolver subscription when worker subscribe succeeded but the tree is not hydrated', () => {
    expect(getTreeRootSubscriptionPlan({
      workerSubscribed: true,
      workerHydrated: false,
    })).toEqual({
      attachWorkerSubscription: true,
      useResolverSubscription: true,
    });
  });

  it('keeps the exact resolver subscription once the specific tree is hydrated', () => {
    expect(getTreeRootSubscriptionPlan({
      workerSubscribed: true,
      workerHydrated: true,
    })).toEqual({
      attachWorkerSubscription: true,
      useResolverSubscription: true,
    });
  });

  it('keeps the exact resolver subscription for link-key routes even after worker hydration', () => {
    expect(getTreeRootSubscriptionPlan({
      workerSubscribed: true,
      workerHydrated: true,
      hasRouteLinkKey: true,
    })).toEqual({
      attachWorkerSubscription: true,
      useResolverSubscription: true,
    });
  });

  it('falls back to the exact resolver subscription when worker support is unavailable', () => {
    expect(getTreeRootSubscriptionPlan({
      workerSubscribed: false,
      workerHydrated: false,
    })).toEqual({
      attachWorkerSubscription: false,
      useResolverSubscription: true,
    });
  });
});

describe('shouldStartTreeRootSubscription', () => {
  it('starts subscriptions for new keys', () => {
    expect(shouldStartTreeRootSubscription({
      hasState: false,
      hasResolverSubscription: false,
      hasWorkerSubscription: false,
    })).toBe(true);
  });

  it('restarts subscriptions when a cached key has no active resolver or worker subscription', () => {
    expect(shouldStartTreeRootSubscription({
      hasState: true,
      hasResolverSubscription: false,
      hasWorkerSubscription: false,
    })).toBe(true);
  });

  it('does not restart when either resolver or worker subscription is already active', () => {
    expect(shouldStartTreeRootSubscription({
      hasState: true,
      hasResolverSubscription: true,
      hasWorkerSubscription: false,
    })).toBe(false);
    expect(shouldStartTreeRootSubscription({
      hasState: true,
      hasResolverSubscription: false,
      hasWorkerSubscription: true,
    })).toBe(false);
  });
});
