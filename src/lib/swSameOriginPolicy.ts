export type SameOriginResponseMode = 'document-coi' | 'subresource-corp' | 'passthrough';

/**
 * Only top-level navigations need synthetic COOP/COEP headers from the service
 * worker. Re-wrapping same-origin subresource responses is unnecessary and can
 * destabilize module workers under service-worker control.
 */
export function getSameOriginResponseMode(request: Pick<Request, 'mode' | 'destination'>): SameOriginResponseMode {
  if (request.mode === 'navigate') {
    return 'document-coi';
  }
  if (request.destination === 'script' || request.destination === 'worker' || request.destination === 'sharedworker') {
    return 'subresource-corp';
  }
  return 'passthrough';
}
