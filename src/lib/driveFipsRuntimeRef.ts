/**
 * The peer network runtime, for code that only reads it (connection stats).
 * Importing the runtime module itself would put the whole peer network on the
 * path to the first screen; it registers here when it loads instead.
 */
import type { DriveFipsRuntime } from './driveFipsRuntime';

let current: () => DriveFipsRuntime | null = () => null;

export function registerDriveFipsRuntimeGetter(getter: () => DriveFipsRuntime | null): void {
  current = getter;
}

/** The running peer network, or null when it is not running or not loaded. */
export function getLoadedDriveFipsRuntime(): DriveFipsRuntime | null {
  return current();
}

// Read-only connection stats for diagnosing the peer network from the console.
if (typeof window !== 'undefined') {
  (window as Window & { __driveFipsStats?: () => ReturnType<DriveFipsRuntime['getStats']> | null })
    .__driveFipsStats = () => current()?.getStats() ?? null;
}
