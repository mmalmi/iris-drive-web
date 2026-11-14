/**
 * Who else has a document open, and where they are in it: Yjs awareness
 * states, one for each open copy. The live channel (liveChannel.ts) carries
 * them, and puts in each the person its signing device belongs to; editors
 * put their own place in with `set` and show the others'.
 */
import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

export interface PresenceUser {
  name: string;
  /** `#rrggbb`, the same for one person everywhere. */
  color: string;
  /** The device's key. */
  key: string;
  /** The person: their Drive profile, else their key. Each person shows once. */
  id: string;
  /** The person's npub, for whether this account follows them. */
  npub?: string;
}

/** Another open copy of the document and what it says about itself. */
export interface PresenceState {
  clientId: number;
  user: PresenceUser;
  [field: string]: unknown;
}

/** Set by an editor: whether it can show where another copy is, and showing it there. */
export interface PresenceFinder {
  can(state: PresenceState): boolean;
  /** Moves the view to them; never changes this person's own selection. */
  go(state: PresenceState): void;
}

/** Draws the eye to where someone was just found: a short pulse of their outline. */
export function flashPresence(element: Element | null | undefined, color: string): void {
  if (!element || typeof element.animate !== 'function') return;
  element.animate([
    { boxShadow: `0 0 0 0 ${color}` },
    { boxShadow: `0 0 0 6px ${color}66` },
    { boxShadow: `0 0 0 0 ${color}00` },
  ], { duration: 900, iterations: 2 });
}

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#d9480f', '#5f3dc4', '#a61e4d', '#087f5b', '#1864ab', '#862e9c'];

/** A colour of its own for a person, the same on every device. */
export function presenceColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

function isUser(value: unknown): value is PresenceUser {
  const user = value as PresenceUser | null;
  return !!user && typeof user.name === 'string' && typeof user.id === 'string' && typeof user.key === 'string'
    && typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color);
}

export class LivePresence {
  readonly awareness: Awareness;
  /** One for each other person who has the document open, in the order they came. */
  peers = $state.raw<Array<PresenceUser & { clientId: number }>>([]);
  /** Every other open copy, for showing where each one is. */
  others = $state.raw<PresenceState[]>([]);
  /** How the editor shows where someone is; null until it has opened. */
  finder = $state.raw<PresenceFinder | null>(null);

  constructor(ydoc: Y.Doc, user: PresenceUser) {
    this.awareness = new Awareness(ydoc);
    this.awareness.setLocalState({ user });
    this.awareness.on('change', this.#refresh);
  }

  get user(): PresenceUser {
    return (this.awareness.getLocalState()?.user as PresenceUser | undefined) ?? { name: '', color: COLORS[0]!, key: '', id: '' };
  }

  setUser(user: PresenceUser): void {
    this.set('user', user);
  }

  /** Says where this copy is, for the others. Nothing is sent when nothing changed. */
  set(field: string, value: unknown): void {
    const state = this.awareness.getLocalState();
    if (!state || JSON.stringify(state[field] ?? null) === JSON.stringify(value ?? null)) return;
    this.awareness.setLocalStateField(field, value);
  }

  destroy(): void {
    this.awareness.off('change', this.#refresh);
    this.awareness.destroy();
  }

  /** The copy a person in `peers` has open, as it says now. */
  stateOf(clientId: number): PresenceState | null {
    return this.others.find(state => state.clientId === clientId) ?? null;
  }

  /** Looks at the states again, after who may be shown changed. */
  refresh(): void {
    this.#refresh();
  }

  readonly #refresh = (): void => {
    const own = this.awareness.clientID;
    const ownKey = this.user.key;
    const others: PresenceState[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      // Another tab of this browser is not someone else.
      if (clientId === own || !isUser(state.user) || state.user.key === ownKey) continue;
      others.push({ ...state, clientId, user: state.user });
    }
    this.others = others;
    // This person's other devices mark their places, but are not someone else in the header.
    const seen = new Set<string>([this.user.id]);
    const peers = others.filter(state => !seen.has(state.user.id) && seen.add(state.user.id))
      .map(state => ({ ...state.user, clientId: state.clientId }));
    const same = peers.length === this.peers.length && peers.every((peer, index) => {
      const before = this.peers[index]!;
      return before.id === peer.id && before.name === peer.name && before.color === peer.color && before.npub === peer.npub;
    });
    if (!same) this.peers = peers;
  };
}
