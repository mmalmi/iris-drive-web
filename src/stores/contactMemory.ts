import { createContactMemoryStore } from '@iris/svelte-ui/contactMemoryStore';
import { nip19 } from 'nostr-tools';

// Shared private state from Iris Kit 2659887. Each account keeps separate records.
export const contactMemory = createContactMemoryStore({
  getItem: key => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

export function contactKey(pubkey: string): string {
  try {
    if (pubkey.startsWith('npub1')) {
      const decoded = nip19.decode(pubkey);
      return decoded.type === 'npub' ? decoded.data : '';
    }
    return /^[a-f0-9]{64}$/i.test(pubkey) ? pubkey.toLowerCase() : '';
  } catch { return ''; }
}

export function rememberContact(viewer: string, pubkey: string, name: string | null): void {
  try { contactMemory.remember(viewer, contactKey(pubkey), name); }
  catch { console.warn('Could not save the contact name on this device.'); }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (!event.key || event.key.startsWith('iris-contact-memory:v1:')) contactMemory.refresh();
  });
}
