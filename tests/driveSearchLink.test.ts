import { describe, expect, it } from 'vitest';
import { nhashEncode } from '@hashtree/core';
import { nip19 } from 'nostr-tools';
import { driveSearchHash } from '../src/lib/driveSearchLink';

const origin = 'http://localhost:5173';
const hex = 'ab'.repeat(32);
const npub = nip19.npubEncode(hex);
const nhash = nhashEncode(hex);

describe('links pasted into Drive search', () => {
  it.each([
    ['https://drive.iris.to/approve-device/Case_123', '#/approve-device/Case_123'],
    ['nostr-identity://device-approval/Case_123', '#/approve-device/Case_123'],
    [origin + '/approve-device/Case_123', '#/approve-device/Case_123'],
    ['iris-drive://share-invite/Case_123', '#/share-invite/Case_123'],
    ['iris-drive:/share-join/Case_123', '#/share-join/Case_123'],
    ['iris-drive://share?path=Photos%2FTrip&name=Trip', '#/share?path=Photos%2FTrip&name=Trip'],
    ['https://drive.iris.to/#/share-join/Case_123', '#/share-join/Case_123'],
    [origin + '/#/photos', '#/photos'],
    [`htree://${nhash}/index.html#/${npub}/main`, `#/${npub}/main`],
    ['  #/recent  ', '#/recent'],
    [hex + '/Trip.jpg', '#/' + nhash + '/Trip.jpg'],
    [nhash + '/Trip.jpg', '#/' + nhash + '/Trip.jpg'],
    ['nostr:' + npub, '#/' + npub],
  ])('opens %s locally', (input, route) => expect(driveSearchHash(input!, origin)).toBe(route));

  it.each(['Trip.jpg', 'npub1unfinished', 'https://example.com/approve-device/abc', 'iris-drive://backup?npub=x',
    'javascript:void(0)#/share', 'https://drive.iris.to/approve-device-other/abc'])(
    'keeps %s as search text', (input) => expect(driveSearchHash(input, origin)).toBeNull(),
  );
});
