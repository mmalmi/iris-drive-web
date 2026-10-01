import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  handlers: [] as Array<{kinds:number[],authors:string[],callback:(event:unknown)=>void}>,
  pubkey: 'a'.repeat(64),
  nostr: {signer: {}, subscribe: vi.fn(), publishEvent: vi.fn()},
}));
vi.mock('../src/nostr/client', () => ({nostr: fixture.nostr}));
vi.mock('../src/nostr', () => ({nostr: fixture.nostr, nostrStore: {getState: () => ({pubkey:fixture.pubkey})}}));
import { createProfileStore, getProfileSync } from '../src/stores/profile';
import { followPubkey, createFollowsStore } from '../src/stores/follows';
import { contactMemory } from '../src/stores/contactMemory';

it('preserves the name seen before following and ignores older profile events', async () => {
  const values = new Map<string,string>();
  vi.stubGlobal('localStorage', {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  fixture.nostr.subscribe.mockImplementation((filter) => ({on:(type:string,callback:(event:unknown)=>void) => {
    if (type==='event') fixture.handlers.push({...filter,callback});
  }, stop:()=>{}}));
  const contact='b'.repeat(64);
  const unsubscribe=createProfileStore(contact).subscribe(()=>{});
  const profile=fixture.handlers.find(h=>h.kinds.includes(0))!;
  profile.callback({pubkey:contact,created_at:20,content:JSON.stringify({name:'Bob'})});
  profile.callback({pubkey:contact,created_at:10,content:JSON.stringify({name:'Outdated'})});
  expect(getProfileSync(contact)?.name).toBe('Bob');
  const follows=createFollowsStore(fixture.pubkey);
  const ownFollows=fixture.handlers.find(h=>h.kinds.includes(3))!;
  ownFollows.callback({pubkey:fixture.pubkey,created_at:10,tags:[['p','c'.repeat(64)]]});
  fixture.nostr.publishEvent.mockImplementation(async () => {
    profile.callback({pubkey:contact,created_at:30,content:JSON.stringify({name:'Robert'})});
  });
  expect(await followPubkey(contact)).toBe(true);
  expect(contactMemory.get(fixture.pubkey,contact)?.accepted_name).toBe('Bob');
  expect(getProfileSync(contact)?.name).toBe('Robert');
  expect(fixture.nostr.publishEvent.mock.calls[0][0].tags).toContainEqual(['p','c'.repeat(64)]);
  unsubscribe(); follows.destroy();
});
