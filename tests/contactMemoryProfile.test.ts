import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from 'nostr-tools';
const fixture = vi.hoisted(() => ({
  requests: [] as Array<{kinds:number[], authors:string[], handlers:Record<string,(event?:unknown)=>void>}>,
  pubkey: '',
  nostr: {signer: {} as object | undefined, subscribe: vi.fn(), signEvent: vi.fn(), publish: vi.fn()},
}));
vi.mock('../src/nostr/client', () => ({nostr: fixture.nostr}));
vi.mock('../src/nostr', () => ({nostr: fixture.nostr, nostrStore: {getState: () => ({pubkey:fixture.pubkey})}}));
import { createProfileStore, getProfileSync } from '../src/stores/profile';
import { get } from 'svelte/store';
import { followPubkey, followSaveError, getFollowsSync, unfollowPubkey } from '../src/stores/follows';
import { contactMemory } from '../src/stores/contactMemory';
let secret: Uint8Array;
let sequence = 0;
const contact='b'.repeat(64), existing='c'.repeat(64);
const head = (tags:string[][],created_at=20): Event => finalizeEvent({kind:3,tags,created_at,content:'{"keep":"this"}'},secret);
async function requestAfter(start:number) {
  await vi.waitFor(() => expect(fixture.requests.slice(start).some(r=>r.kinds.includes(3))).toBe(true));
  return fixture.requests.slice(start).find(r=>r.kinds.includes(3))!;
}
beforeEach(() => {
  vi.useRealTimers(); fixture.requests=[]; fixture.nostr.signEvent.mockReset(); fixture.nostr.publish.mockReset();
  secret=new Uint8Array(32);secret[31]=++sequence;fixture.pubkey=getPublicKey(secret);fixture.nostr.signer={};
  const values = new Map<string,string>();
  vi.stubGlobal('localStorage', {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  fixture.nostr.subscribe.mockImplementation((filter) => {
    const request={...filter,handlers:{}};fixture.requests.push(request);
    return {on:(type:string,callback:(event:unknown)=>void) => {request.handlers[type]=callback;},stop:()=>{request.handlers.close?.();}};
  });
  fixture.nostr.signEvent.mockImplementation(async (draft:EventTemplate) => finalizeEvent(draft,secret));
  fixture.nostr.publish.mockResolvedValue(undefined);
});
const signed = (call=0) => fixture.nostr.signEvent.mock.calls[call][0];
it('shows a follow at once, then signs it onto the complete signed list and saves the name seen before follow', async () => {
  const unsubscribe=createProfileStore(contact).subscribe(()=>{});
  // Profile lookups are batched, so the request follows a moment later.
  const profile=await vi.waitFor(() => { const request=fixture.requests.find(r=>r.kinds.includes(0)); expect(request).toBeDefined(); return request!; });
  profile.handlers.event({pubkey:contact,created_at:20,content:JSON.stringify({name:'Bob'})});
  profile.handlers.event({pubkey:contact,created_at:10,content:JSON.stringify({name:'Outdated'})});
  expect(getProfileSync(contact)?.name).toBe('Bob');
  const started=fixture.requests.length;
  expect(await followPubkey(contact)).toBe(true);
  // Nothing has answered yet: the change is on screen, nothing is signed.
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([contact]);
  expect(contactMemory.get(fixture.pubkey,contact)?.accepted_name).toBe('Bob');
  expect(fixture.nostr.signEvent).not.toHaveBeenCalled();
  const own=await requestAfter(started);
  const tags=[['p',existing,'wss://example.invalid','friend'],['t','music'],['client','iris']];
  own.handlers.event(head([['p','d'.repeat(64)]],10));
  own.handlers.event(head(tags));
  own.handlers.event(head([['p','d'.repeat(64)]],15));
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([existing,contact]);
  profile.handlers.event({pubkey:contact,created_at:30,content:JSON.stringify({name:'Robert'})});
  own.handlers.history({complete:true,reason:'eose'});
  await vi.waitFor(()=>expect(fixture.nostr.publish).toHaveBeenCalledOnce());
  expect(signed()).toMatchObject({content:'{"keep":"this"}',tags:[...tags,['p',contact]]});
  expect(contactMemory.get(fixture.pubkey,contact)?.accepted_name).toBe('Bob');
  expect(getProfileSync(contact)?.name).toBe('Robert');
  // History is complete now, so the next change is signed without asking again.
  own.handlers.event(head(tags)); // A stale relay cannot erase the locally published list.
  expect(await unfollowPubkey(contact)).toBe(true);
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([existing]);
  await vi.waitFor(()=>expect(fixture.nostr.publish).toHaveBeenCalledTimes(2));
  expect(signed(1)).toMatchObject({content:'{"keep":"this"}',tags});
  expect(get(followSaveError)).toBe('');
  unsubscribe();
});
it('does not wait for a relay to accept the list', async () => {
  fixture.nostr.publish.mockReturnValue(new Promise(()=>{}));
  expect(await followPubkey(contact)).toBe(true);
  const own=await requestAfter(0);
  own.handlers.event(head([['p',existing]]));own.handlers.history({complete:true,reason:'eose'});
  await vi.waitFor(()=>expect(fixture.nostr.publish).toHaveBeenCalledOnce());
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([existing,contact]);
  // The next change builds on the list just signed, not on what relays hold.
  const other='e'.repeat(64);
  expect(await followPubkey(other)).toBe(true);
  await vi.waitFor(()=>expect(fixture.nostr.publish).toHaveBeenCalledTimes(2));
  expect(signed(1).tags).toEqual([['p',existing],['p',contact],['p',other]]);
});
it('builds on a known list after a short wait when a relay never finishes', async () => {
  vi.useFakeTimers();
  try {
    expect(await followPubkey(contact)).toBe(true);
    const own=fixture.requests.find(r=>r.kinds.includes(3))!;
    own.handlers.event(head([['p',existing]]));
    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.nostr.signEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(signed().tags).toEqual([['p',existing],['p',contact]]);
    expect(fixture.nostr.publish).toHaveBeenCalledOnce();
  } finally {vi.useRealTimers();}
});
it('keeps a change queued, and says so, while no relay can tell whether a list exists', async () => {
  vi.useFakeTimers();
  try {
    expect(await followPubkey(contact)).toBe(true);
    const first=fixture.requests.find(r=>r.kinds.includes(3))!;
    first.handlers.history({complete:false,reason:'unavailable'});
    await vi.advanceTimersByTimeAsync(10_001);
    // Publishing now could replace a list this device has never seen.
    expect(fixture.nostr.signEvent).not.toHaveBeenCalled();
    expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([contact]);
    expect(get(followSaveError)).toMatch(/Not saved yet/);
    // Relays are asked again; the queued change is saved once one answers.
    const asked=fixture.requests.filter(r=>r.kinds.includes(3));
    expect(asked.length).toBeGreaterThan(1);
    asked.at(-1)!.handlers.event(head([['p',existing]]));
    asked.at(-1)!.handlers.history({complete:true,reason:'eose'});
    await vi.advanceTimersByTimeAsync(1);
    expect(signed().tags).toEqual([['p',existing],['p',contact]]);
    expect(get(followSaveError)).toBe('');
  } finally {vi.useRealTimers();}
});
it('starts an empty list only when relays have finished and hold none', async () => {
  expect(await followPubkey(contact)).toBe(true);
  const own=await requestAfter(0);
  expect(fixture.nostr.signEvent).not.toHaveBeenCalled();
  own.handlers.history({complete:true,reason:'eose'});
  await vi.waitFor(()=>expect(fixture.nostr.publish).toHaveBeenCalledOnce());
  expect(signed().tags).toEqual([['p',contact]]);
});
it('ignores unsigned lists and drops queued changes when the account changes', async () => {
  expect(await followPubkey(contact)).toBe(true);
  const own=await requestAfter(0);
  own.handlers.event({...JSON.parse(JSON.stringify(head([['p',existing]]))),sig:'invalid'});
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([contact]);
  fixture.pubkey='d'.repeat(64);
  own.handlers.history({complete:true,reason:'eose'});
  await Promise.resolve();
  expect(fixture.nostr.signEvent).not.toHaveBeenCalled();
});
it('undoes the change on screen and reports it when signing is refused', async () => {
  fixture.nostr.signEvent.mockRejectedValue(new Error('refused'));
  expect(await followPubkey(contact)).toBe(true);
  const own=await requestAfter(0);
  own.handlers.event(head([['p',existing]]));own.handlers.history({complete:true,reason:'eose'});
  await vi.waitFor(()=>expect(get(followSaveError)).toBe('Could not update follows.'));
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([existing]);
  expect(fixture.nostr.publish).not.toHaveBeenCalled();
});
it('keeps the signed change and reports it when it cannot be handed to the publisher', async () => {
  fixture.nostr.publish.mockRejectedValue(new Error('no backend'));
  expect(await followPubkey(contact)).toBe(true);
  const own=await requestAfter(0);
  own.handlers.event(head([['p',existing]]));own.handlers.history({complete:true,reason:'eose'});
  await vi.waitFor(()=>expect(get(followSaveError)).toMatch(/Could not send/));
  expect(getFollowsSync(fixture.pubkey)?.follows).toEqual([existing,contact]);
});
it('refuses without an account or a valid key', async () => {
  expect(await followPubkey('not-a-key')).toBe(false);
  fixture.nostr.signer=undefined;
  expect(await followPubkey(contact)).toBe(false);
  expect(fixture.requests.filter(r=>r.kinds.includes(3))).toHaveLength(0);
});
