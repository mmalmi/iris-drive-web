export interface TreeRootSubscriptionPlan {
  attachWorkerSubscription: boolean;
  useResolverSubscription: boolean;
}

export function shouldStartTreeRootSubscription(options: {
  hasState: boolean;
  hasResolverSubscription: boolean;
  hasWorkerSubscription: boolean;
}): boolean {
  const { hasState, hasResolverSubscription, hasWorkerSubscription } = options;
  return !hasState || (!hasResolverSubscription && !hasWorkerSubscription);
}

export function getTreeRootSubscriptionPlan(options: {
  workerSubscribed: boolean;
  workerHydrated: boolean;
  hasRouteLinkKey?: boolean;
}): TreeRootSubscriptionPlan {
  const { workerSubscribed } = options;
  return {
    attachWorkerSubscription: workerSubscribed,
    // Keep the exact resolver subscription even when the worker has a cached root.
    // Old sessions can otherwise stay pinned to stale or incomplete worker cache state.
    useResolverSubscription: true,
  };
}
