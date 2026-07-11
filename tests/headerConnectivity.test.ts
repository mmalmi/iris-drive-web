import { describe, expect, it } from 'vitest';
import { shouldShowHeaderConnectivityIndicator } from '../src/lib/headerConnectivity';

describe('shouldShowHeaderConnectivityIndicator', () => {
  it('keeps a healthy connection out of the header by default', () => {
    expect(shouldShowHeaderConnectivityIndicator({
      showConnectivityInHeader: false,
      connectedRelays: 2,
      connectedPeers: 3,
      startupGraceElapsed: true,
    })).toBe(false);
  });

  it('shows an offline warning after the startup grace period', () => {
    expect(shouldShowHeaderConnectivityIndicator({
      showConnectivityInHeader: false,
      connectedRelays: 0,
      connectedPeers: 0,
      startupGraceElapsed: true,
    })).toBe(true);
  });

  it('does not flash an offline warning while connections initialize', () => {
    expect(shouldShowHeaderConnectivityIndicator({
      showConnectivityInHeader: false,
      connectedRelays: 0,
      connectedPeers: 0,
      startupGraceElapsed: false,
    })).toBe(false);
  });

  it('honors the explicit always-show preference', () => {
    expect(shouldShowHeaderConnectivityIndicator({
      showConnectivityInHeader: true,
      connectedRelays: 1,
      connectedPeers: 0,
      startupGraceElapsed: false,
    })).toBe(true);
  });
});
