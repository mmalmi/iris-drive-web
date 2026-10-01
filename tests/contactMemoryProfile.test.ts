import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from 'nostr-tools';
const fixture = vi.hoisted(() => ({
  requests: [] as Array<{kinds:number[], authors:string[], handlers:Record<string,(event?:unknown)=>void>}>,
  pubkey: '',
  adapter: null as null | {queryEvents: ReturnType<typeof vi.fn>},
  relays: ['wss://example.invalid'],
  nostr: {signer: {} as object | undefined, subscribe: vi.fn(), publishEvent: vi.fn()},
}));
vi.mock('../src/nostr/client', () => ({nostr: fixture.nostr, getNostrRelayUrls: () => fixture.relays}));
vi.mock('../src/workerAdapter', () => ({getWorkerAdapter: () => fixture.adapter}));
vi.mock('../src/nostr', () => ({nostr: fixture.nostr, nostrStore: {getState: () => ({pubkey:fixture.pubkey})}}));
import { createProfileStore, getProfileSync } from '../src/stores/profile';
import { followPubkey, unfollowPubkey } from '../src/stores/follows';
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
  vi.useRealTimers(); fixture.requests=[]; fixture.adapter=null; fixture.relays=['wss://example.invalid']; fixture.nostr.publishEvent.mockReset();
  secret=new Uint8Array(32);secret[31]=++sequence;fixture.pubkey=getPublicKey(secret);fixture.nostr.signer={};
  const values = new Map<string,string>();
  vi.stubGlobal('localStorage', {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  fixture.nostr.subscribe.mockImplementation((filter) => {
    const request={...filter,handlers:{}};fixture.requests.push(request);
    return {on:(type:string,callback:(event:unknown)=>void) => {request.handlers[type]=callback;},stop:()=>{request.handlers.close?.();}};
  });
  fixture.nostr.publishEvent.mockImplementation(async (draft:EventTemplate) => finalizeEvent(draft,secret));
});
it('waits for latest signed history, preserves all tags/content, and saves the name seen before follow', async () => {
  const unsubscribe=createProfileStore(contact).subscribe(()=>{});
  const profile=fixture.requests.find(r=>r.kinds.includes(0))!;
  profile.handlers.event({pubkey:contact,created_at:20,content:JSON.stringify({name:'Bob'})});
  profile.handlers.event({pubkey:contact,created_at:10,content:JSON.stringify({name:'Outdated'})});
  expect(getProfileSync(contact)?.name).toBe('Bob');
  const started=fixture.requests.length, pending=followPubkey(contact);
  const own=await requestAfter(started);
  const tags=[['p',existing,'wss://example.invalid','friend'],['t','music'],['client','iris']];
  own.handlers.event(head([['p','d'.repeat(64)]],10));
  own.handlers.event(head(tags));
  own.handlers.event(head([['p','d'.repeat(64)]],15));
  expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
  profile.handlers.event({pubkey:contact,created_at:30,content:JSON.stringify({name:'Robert'})});
  own.handlers.history({complete:true,reason:'eose'});
  expect(await pending).toBe(true);
  expect(fixture.nostr.publishEvent.mock.calls[0][0]).toMatchObject({content:'{"keep":"this"}',tags:[...tags,['p',contact]]});
  expect(contactMemory.get(fixture.pubkey,contact)?.accepted_name).toBe('Bob');
  expect(getProfileSync(contact)?.name).toBe('Robert');
  const nextStart=fixture.requests.length, removing=unfollowPubkey(contact), next=await requestAfter(nextStart);
  next.handlers.event(head(tags)); // A stale relay cannot erase the locally published head.
  next.handlers.history({complete:true,reason:'eose'});
  expect(await removing).toBe(true);
  expect(fixture.nostr.publishEvent.mock.calls[1][0]).toMatchObject({content:'{"keep":"this"}',tags});
  unsubscribe();
});
it('refuses partial history even after receiving a valid event', async () => {
  const pending=followPubkey(contact), own=await requestAfter(0);
  own.handlers.event(head([['p',existing]]));
  own.handlers.history({complete:false,reason:'unavailable'});
  expect(await pending).toBe(false);expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
  expect(contactMemory.get(fixture.pubkey,contact)).toBeNull();
});
it('refuses unsigned heads and account changes while fetching history', async () => {
  const pending=followPubkey(contact), own=await requestAfter(0);
  own.handlers.event({...JSON.parse(JSON.stringify(head([['p',existing]]))),sig:'invalid'});
  own.handlers.history({complete:true,reason:'eose'});
  expect(await pending).toBe(false);
  const start=fixture.requests.length, second=followPubkey(contact), next=await requestAfter(start);
  next.handlers.event(head([['p',existing]]));fixture.pubkey='d'.repeat(64);
  next.handlers.history({complete:true,reason:'eose'});
  expect(await second).toBe(false);expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
});
it('refuses a backend closing before history completes', async () => {
  const pending=followPubkey(contact);await requestAfter(0);
  // Closing a backend before history is complete must fail just like a timeout.
  fixture.requests.find(r=>r.kinds.includes(3))!.handlers.close();
  expect(await pending).toBe(false);expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
});
it('serializes concurrent edits and keeps a newer local head while relays lag', async () => {
  const other='e'.repeat(64), initial=head([['p',existing],['client','iris']]);
  const first=followPubkey(contact), second=followPubkey(other), own=await requestAfter(0);
  expect(fixture.requests.filter(r=>r.kinds.includes(3))).toHaveLength(1);
  own.handlers.event(initial);own.handlers.history({complete:true,reason:'eose'});
  expect(await first).toBe(true);
  const next=await requestAfter(1);
  next.handlers.event(initial);next.handlers.history({complete:true,reason:'eose'});
  expect(await second).toBe(true);
  expect(fixture.nostr.publishEvent.mock.calls[1][0].tags).toEqual([['p',existing],['client','iris'],['p',contact],['p',other]]);
});
it('times out without publishing when history never completes', async () => {
  vi.useFakeTimers();
  try {
    const pending=followPubkey(contact);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBe(false);
    expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
});

it('uses completed relay-scoped worker history when optional peer history is unavailable', async () => {
  let finish!: (result: unknown) => void;
  const queryEvents=vi.fn(() => new Promise(resolve => {finish=resolve;}));
  fixture.adapter={queryEvents};
  const pending=followPubkey(contact);
  await vi.waitFor(()=>expect(queryEvents).toHaveBeenCalledOnce());
  expect(queryEvents.mock.calls[0]).toEqual([[{kinds:[3],authors:[fixture.pubkey]}], {
    cache:'cache-first',relays:fixture.relays,deadline:expect.any(Number),
  }]);
  expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
  const tags=[['p',existing,'wss://hint.invalid','friend'],['client','iris']];
  finish({complete:true,reason:'eose',events:[head(tags)]});
  expect(await pending).toBe(true);
  expect(fixture.nostr.publishEvent.mock.calls[0][0]).toMatchObject({content:'{"keep":"this"}',tags:[...tags,['p',contact]]});
});
it('refuses unavailable, invalid, or unconfigured worker relay history', async () => {
  const queryEvents=vi.fn().mockResolvedValue({complete:false,events:[head([['p',existing]])]});
  fixture.adapter={queryEvents};
  expect(await followPubkey(contact)).toBe(false);
  queryEvents.mockResolvedValue({complete:true,events:[{...JSON.parse(JSON.stringify(head([['p',existing]]))),sig:'invalid'}]});
  expect(await followPubkey(contact)).toBe(false);
  queryEvents.mockClear();fixture.relays=[];
  expect(await followPubkey(contact)).toBe(false);
  expect(queryEvents).not.toHaveBeenCalled();
  expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
});
it('refuses a replaced worker backend before publishing', async () => {
  fixture.adapter={queryEvents:vi.fn(async()=>{fixture.adapter=null;return {complete:true,events:[head([])]};})};
  expect(await followPubkey(contact)).toBe(false);
  expect(fixture.nostr.publishEvent).not.toHaveBeenCalled();
});
