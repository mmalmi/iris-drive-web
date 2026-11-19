import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type TreeEntry } from '@hashtree/core';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { createHash } from 'node:crypto';
import fixture from './fixtures/shared-file-return-v1.json';
import { addShareRecipients, createSharedFolder } from '../src/drive/shareAdmin';
import { buildDriveRootEvent, parseDriveRootEventForDevice, type SharedFolder } from '../src/drive/protocol';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import {
  claimCopiedDirectory,
  claimNewFile,
  currentReturn,
  fileRevision,
  openReturnNote,
  OWNER_META,
  parseRequest,
  readFileOwner,
  REQUEST_META,
  requestFileReturn,
  returnNotes,
  storedReceipt,
} from '../src/drive/fileReturnProtocol';
import { finishFileReturn, retainFileReturns, verifyMarker, type ReturnMarker } from '../src/drive/fileReturnMarker';
import { resolveEntry } from '../src/drive/profileDriveMutation';

const owner = new Uint8Array(32).fill(fixture.owner_key_byte);
const editor = new Uint8Array(32).fill(fixture.editor_key_byte);
const editorId = '00000000-0000-4000-8000-000000000003';
const reader = generateSecretKey();
function folder(): SharedFolder {
  const initial = createSharedFolder({
    signerSecretKey: owner,
    ownerProfileId: fixture.owner,
    ownerDevices: [],
    shareId: fixture.share,
    sourcePath: 'Trip',
    displayName: 'Trip',
    createdAt: 3,
  });
  return addShareRecipients(
    initial,
    owner,
    [
      { profile_id: editorId, app_pubkey: getPublicKey(editor), role: 'editor' },
      { profile_id: '00000000-0000-4000-8000-000000000004', app_pubkey: getPublicKey(reader), role: 'reader' },
    ],
    4,
  );
}

describe('shared file owner return', () => {
  it('opens the portable encrypted request and receipt only for their recipients', () => {
    const request = openReturnNote(fixture.ask as Event, owner);
    const stored = openReturnNote(fixture.stored as Event, editor);
    expect(request?.request.event.id).toBe(fixture.request.id);
    expect(stored?.receipt?.id).toBe(fixture.marker.receipt.id);
    expect(verifyMarker(fixture.marker as ReturnMarker, folder())?.path).toEqual(fixture.path);
    expect(openReturnNote(fixture.stored as Event, reader)).toBeNull();
    expect(openReturnNote({ ...fixture.ask, content: fixture.stored.content } as Event, owner)).toBeNull();
  });

  it('uses the full production encryption key and retains the individual owner across edits and renames', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const first = await tree.putFile(new TextEncoder().encode('draft'));
    const edited = await tree.putFile(new TextEncoder().encode('edited'));
    const key = edited.cid.key!;
    expect(key.length).toBe(33);
    const digest = createHash('sha256')
      .update(['iris-drive-file-revision-v1', toHex(edited.cid.hash), toHex(key)].join('\n'))
      .digest('hex');
    expect(fileRevision(edited.cid)).toBe(digest);
    const file: TreeEntry = {
      ...edited,
      name: 'renamed.txt',
      type: LinkType.Blob,
      meta: { [OWNER_META]: claimNewFile(fixture.share, fixture.owner, first.cid, owner) },
    };
    const access = folder();
    const proof = readFileOwner(file, access)!;
    const request = requestFileReturn(proof, edited.cid, [file.name], editor, {});
    file.meta![REQUEST_META] = JSON.stringify(request);
    expect(currentReturn(access, [file.name], file)?.value.owner).toBe(fixture.owner);
    expect(currentReturn(access, ['different.txt'], file)).toBeNull();
    expect(currentReturn(access, [file.name], { ...file, cid: first.cid })).toBeNull();
    expect(readFileOwner({ ...file, meta: {} }, access)).toBeNull();
    const readerRequest = requestFileReturn(proof, edited.cid, [file.name], reader, {});
    expect(
      currentReturn(access, [file.name], {
        ...file,
        meta: { ...file.meta, [REQUEST_META]: JSON.stringify(readerRequest) },
      }),
    ).toBeNull();
    const parsed = parseRequest(JSON.stringify(request))!;
    const wrongReceipt = storedReceipt(parsed, editor);
    expect(verifyMarker({ v: 1, claim: proof.event, request, receipt: wrongReceipt }, access)).toBeNull();
    const [ack] = returnNotes(parsed, 'stored', owner, [getPublicKey(editor)]);
    expect(openReturnNote(ack, editor)?.receipt?.pubkey).toBe(getPublicKey(owner));
  });

  it('assigns fresh ownership to a copied folder without carrying its return requests or history', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const file = await tree.putFile(new TextEncoder().encode('A separate copy'));
    const meta = {
      [OWNER_META]: claimNewFile(fixture.share, fixture.owner, file.cid, owner),
      [REQUEST_META]: 'previous request',
    };
    const directory = await tree.putDirectory([
      { ...file, type: LinkType.Blob, name: 'copy.txt', meta },
      { ...file, type: LinkType.Blob, name: '.hashtree' },
    ]);
    const root = await claimCopiedDirectory(tree, directory.cid, fixture.share, editorId, editor);
    const children = await tree.listDirectory(root);
    expect(children.map((entry) => entry.name)).toEqual(['copy.txt']);
    expect(children[0].cid).toEqual(file.cid);
    expect(children[0].meta?.[REQUEST_META]).toBeUndefined();
    const claim = readFileOwner(children[0], folder());
    expect(claim?.value.owner).toBe(editorId);
    expect(claim?.event.id).not.toBe(JSON.parse(meta[OWNER_META]).id);
  });

  it('keeps an unseen concurrent edit while suppressing the confirmed and previously observed versions', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const access = folder();
    const path = ['file.txt'];
    const first = await tree.putFile(new TextEncoder().encode('first'));
    const edited = await tree.putFile(new TextEncoder().encode('returned'));
    const concurrent = await tree.putFile(new TextEncoder().encode('unseen'));
    const meta = { [OWNER_META]: claimNewFile(fixture.share, fixture.owner, first.cid, owner) };
    const entry = { ...edited, name: path[0], type: LinkType.Blob, meta };
    const proof = readFileOwner(entry, access)!;
    const request = requestFileReturn(proof, edited.cid, path, editor, { [getPublicKey(owner)]: 1 });
    const signed = parseRequest(JSON.stringify(request))!;
    const marker = { v: 1 as const, claim: proof.event, request, receipt: storedReceipt(signed, owner) };
    const pending = (
      await tree.putDirectory([{ ...entry, meta: { ...meta, [REQUEST_META]: JSON.stringify(request) } }])
    ).cid;
    const completed = await finishFileReturn(tree, pending, path, marker);
    const projection = new ProfileDriveProjection();
    function contribute(signer: Uint8Array, seq: number, root: typeof completed) {
      const event = buildDriveRootEvent({
        deviceSecretKey: signer,
        rootScopeId: fixture.share,
        driveId: 'main',
        root,
        authorizedAppKeyPubkeys: [getPublicKey(owner)],
        dckGeneration: 1,
        appKeySeq: seq,
        publishedAt: 100 + seq,
      });
      projection.add(event, parseDriveRootEventForDevice(event, owner));
    }
    async function project() {
      const view = await projection.materialize(
        tree,
        fixture.share,
        'main',
        new Set([getPublicKey(owner), getPublicKey(editor)]),
        undefined,
        access,
      );
      return resolveEntry(tree, view!.root, path);
    }
    const staleWrite = (await tree.putDirectory([])).cid;
    const retained = await retainFileReturns(tree, staleWrite, completed);
    const slot = await tree.resolvePath(retained, ['.hashtree', 'file-returns-v1', request.id + '.json']);
    expect(slot?.type).toBe(LinkType.Blob);
    contribute(editor, 2, retained);
    contribute(owner, 1, (await tree.putDirectory([{ ...entry, ...first }])).cid);
    expect(await project()).toBeNull();
    const reads = vi.spyOn(tree, 'readFile');
    expect(await project()).toBeNull();
    expect(reads.mock.calls.some(([cid]) => toHex(cid.hash) === toHex(slot!.cid.hash))).toBe(false);
    reads.mockRestore();
    contribute(owner, 2, (await tree.putDirectory([{ ...entry, ...concurrent }])).cid);
    expect((await project())?.cid).toEqual(concurrent.cid);
    contribute(owner, 3, (await tree.putDirectory([entry])).cid);
    expect(await project()).toBeNull();
  });
});
