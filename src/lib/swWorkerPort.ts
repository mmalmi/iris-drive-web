export interface WorkerPortRegistry<T> {
  byClientId: Map<string, T>;
  byClientKey: Map<string, T>;
  defaultPort: T | null;
}

export function lookupWorkerPort<T>(
  registry: WorkerPortRegistry<T>,
  clientId?: string | null,
  clientKey?: string | null,
): T | null {
  if (clientKey && registry.byClientKey.has(clientKey)) {
    return registry.byClientKey.get(clientKey) ?? null;
  }
  if (clientId && registry.byClientId.has(clientId)) {
    return registry.byClientId.get(clientId) ?? null;
  }
  return registry.defaultPort;
}

export async function waitForWorkerPort<T>(
  lookup: () => T | null,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  let port = lookup();
  if (port) return port;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    port = lookup();
    if (port) return port;
  }

  return null;
}
