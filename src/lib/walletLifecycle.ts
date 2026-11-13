/**
 * The wallet starts only when its page is opened, so most visits never load
 * it. Signing out or switching accounts must still stop a wallet that runs;
 * the wallet module registers how here when it loads, and nothing is loaded
 * just to stop a wallet that never started.
 */
let stopWallet: (() => Promise<void>) | null = null;

export function registerWalletStop(stop: () => Promise<void>): void {
  stopWallet = stop;
}

/** Stops the wallet if it was ever loaded. */
export function stopLoadedWallet(): Promise<void> {
  return stopWallet ? stopWallet() : Promise.resolve();
}
