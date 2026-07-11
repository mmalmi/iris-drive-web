export const HEADER_CONNECTIVITY_WARNING_STARTUP_GRACE_MS = 3_000;

export function shouldShowHeaderConnectivityIndicator(options: {
  showConnectivityInHeader: boolean;
  connectedRelays: number;
  connectedPeers: number;
  startupGraceElapsed: boolean;
}): boolean {
  if (options.showConnectivityInHeader) return true;

  return options.startupGraceElapsed
    && options.connectedRelays + options.connectedPeers === 0;
}
