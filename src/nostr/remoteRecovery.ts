import { pairBrowserSigner, restoreBrowserSigner, type BrowserSignerSession } from '@iris/identity/browserSigner';
import { parseBunkerInput, toBunkerURL } from 'nostr-tools/nip46';

/** The recovered account authorizes this device. Only the device key survives recovery. */
export async function createRemoteRecoverySigner(connection: string | BrowserSignerSession, relay?: string) {
  const controller = new AbortController();
  let session: BrowserSignerSession;
  if (typeof connection === 'string') {
    const pointer = await parseBunkerInput(connection);
    if (!pointer) throw new Error('Invalid signer connection.');
    if (relay) pointer.relays = [relay];
    session = await pairBrowserSigner(toBunkerURL(pointer), {
      name: 'Iris Drive', permissions: 'sign_event,nip44_encrypt,nip44_decrypt', signal: controller.signal,
    });
  } else {
    session = connection;
  }
  return Object.assign(restoreBrowserSigner(session, { signal: controller.signal }), {
    close: async () => { controller.abort(); },
  });
}
