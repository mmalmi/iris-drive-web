import { describe, expect, it } from 'vitest';
import { LinkType, toHex, type CID } from '@hashtree/core';
import {
  albumAdditions, albumHref, arrangePhotos, countLabel, dateHeading, photoAlbums, photoDating, photosFound, photosPage, photosUploadPlace,
  uniquePhotos, type Photo,
} from '../src/lib/photos';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const NOW = new Date(2026, 10, 14, 15, 0, 0);
const at = (...parts: [number, number, number, number?]) => new Date(parts[0], parts[1], parts[2], parts[3] ?? 12).getTime() / 1000;
const cidOf = (n: number): CID => ({ hash: new Uint8Array(32).fill(n) });
const heading = (seconds: number | null) => dateHeading(seconds, NOW, 'en-GB').label;
const noDates = new Map<string, number | null>();

/** A photo with content `n` at `path` of a tree (My Drive unless `scope` is a shared folder's). */
function photo(path: string | string[], modified: number | null, n: number, scope = 'me'): Photo {
  const parts = Array.isArray(path) ? path : [path];
  const shared = scope !== 'me';
  const label = shared ? 'Holiday' : 'My Drive';
  return {
    href: `#/${scope}/main/${parts.join('/')}`,
    name: parts[parts.length - 1]!,
    cid: cidOf(n),
    type: LinkType.Blob,
    hash: toHex(cidOf(n).hash),
    size: 1,
    scope,
    path: parts,
    label,
    shared,
    where: [label, ...parts.slice(0, -1)].join(' / '),
    video: /\.(mov|mp4)$/.test(parts[parts.length - 1]!),
    modified,
  };
}

const names = (photos: Photo[]) => photos.map((p) => p.path.join('/'));

describe('the heading a photo is under', () => {
  it('is the day for the last month, then the month', () => {
    expect(heading(at(2026, 10, 14, 1))).toBe('Today');
    expect(heading(at(2026, 10, 13, 23))).toBe('Yesterday');
    expect(heading(at(2026, 10, 12))).toBe('12 Nov');
    expect(heading(at(2026, 9, 16))).toBe('16 Oct');
    expect(heading(at(2026, 9, 2))).toBe('October 2026');
    expect(heading(at(2025, 10, 30))).toBe('November 2025');
    expect(heading(null)).toBe('No date');
  });

  it('names the year of a day in the year before', () => {
    expect(dateHeading(at(2026, 11, 28), new Date(2027, 0, 5), 'en-GB').label).toBe('28 Dec 2026');
  });
});

describe('arranging photos', () => {
  it('puts the newest first under their headings, by the camera\'s date where it is known, and those with no date last', () => {
    const today = photo('today.png', at(2026, 10, 14, 9), 1);
    const uploadedToday = photo('beach.jpg', at(2026, 10, 14, 10), 2);
    const yesterday = photo('cat.jpg', at(2026, 10, 13), 3);
    const old = photo('old.gif', at(2026, 8, 3), 4);
    const undated = photo('undated.webp', null, 5);
    const all = [undated, old, yesterday, today, uploadedToday];
    const taken = new Map([[uploadedToday.hash, at(2025, 6, 1)], [yesterday.hash, null]]);

    const groups = arrangePhotos(all, photoDating(all, taken), NOW, 'en-GB');
    expect(groups.map((group) => [group.label, group.photos.map((p) => p.name)])).toEqual([
      ['Today', ['today.png']],
      ['Yesterday', ['cat.jpg']],
      ['September 2026', ['old.gif']],
      ['July 2025', ['beach.jpg']],
      ['No date', ['undated.webp']],
    ]);
  });
});

describe('a photo in several folders', () => {
  const original = photo(['Photos', 'sea.jpg'], at(2026, 7, 1), 1);
  const inAlbum = photo(['Photos', 'Trip', 'sea.jpg'], at(2026, 10, 14), 1);
  const inShared = photo(['sea (2).jpg'], at(2026, 9, 1), 1, 'share-1');
  const other = photo(['Photos', 'Trip', 'boat.jpg'], at(2026, 10, 13), 2);
  const all = [inAlbum, other, inShared, original];

  it('is in the timeline once, as the copy that came first', () => {
    expect(names(uniquePhotos(all))).toEqual(['Photos/sea.jpg', 'Photos/Trip/boat.jpg']);
  });

  it('keeps the date it first had, wherever it was added since', () => {
    const dating = photoDating(all, noDates);
    expect(dating(inAlbum)).toBe(at(2026, 7, 1));
    expect(arrangePhotos(uniquePhotos(all), dating, NOW, 'en-GB').map((group) => group.label)).toEqual(['Yesterday', 'August 2026']);
  });
});

describe('albums', () => {
  it('are the folders that hold photos themselves, newest first, each with its own copies', () => {
    const all = [
      photo(['Photos', 'a.jpg'], at(2026, 10, 1), 1),
      photo(['Photos', 'Trip', 'a.jpg'], at(2026, 10, 2), 1),
      photo(['Photos', 'Trip', 'b.mov'], at(2026, 10, 3), 2),
      photo(['Photos', 'Trip', 'Day 2', 'c.jpg'], at(2026, 9, 1), 3),
      photo(['loose.jpg'], at(2026, 10, 10), 4),
      photo(['top.jpg'], at(2026, 10, 12), 5, 'share-1'),
    ];
    const albums = photoAlbums(all, photoDating(all, noDates));
    expect(albums.map((album) => [album.scope, album.path.join('/'), album.name, names(album.photos), countLabel(album.photos)])).toEqual([
      // The top of a shared folder is an album; the top of My Drive is none.
      ['share-1', '', 'Holiday', ['top.jpg'], '1 photo'],
      ['me', 'Photos/Trip', 'Trip', ['Photos/Trip/b.mov', 'Photos/Trip/a.jpg'], '2 items'],
      ['me', 'Photos', 'Photos', ['Photos/a.jpg'], '1 photo'],
      ['me', 'Photos/Trip/Day 2', 'Day 2', ['Photos/Trip/Day 2/c.jpg'], '1 photo'],
    ]);
  });

  it('take what is added by content: once, under a free name where a different file has its name', () => {
    const there = [
      { name: 'sea.jpg', cid: cidOf(1) },
      { name: 'boat.jpg', cid: cidOf(9) },
    ];
    const additions = albumAdditions(there, [
      photo(['sea.jpg'], null, 1),
      photo(['Photos', 'boat.jpg'], null, 2),
      photo(['Other', 'boat.jpg'], null, 3),
      photo(['again', 'boat.jpg'], null, 2),
      photo(['moon.jpg'], null, 4),
    ]);
    expect(additions.map(({ name, photo: added }) => [name, added.path.join('/')])).toEqual([
      ['boat (2).jpg', 'Photos/boat.jpg'],
      ['boat (3).jpg', 'Other/boat.jpg'],
      ['moon.jpg', 'moon.jpg'],
    ]);
  });

  it('open at an address of their own', () => {
    const href = albumHref('me', ['Photos', 'Summer 2026']);
    expect(href).toBe('#/photos/album/me/Photos/Summer%202026');
    expect(photosPage(href.slice(1))).toEqual({ kind: 'album', scope: 'me', path: ['Photos', 'Summer 2026'] });
    expect(photosPage('/photos/album/share-1')).toEqual({ kind: 'album', scope: 'share-1', path: [] });
    expect(photosPage('/photos/albums')).toEqual({ kind: 'albums' });
    expect(photosPage('/photos')).toEqual({ kind: 'timeline' });
  });
});

describe('the photos in a tree', () => {
  it('are its pictures and videos, wherever they are, with where they open', () => {
    const file = (name: string, meta?: Record<string, unknown>) => ({ name, cid: cidOf(name.length), size: 10, type: LinkType.Blob, meta });
    const found = [
      { path: ['Trip'], entry: { ...file('Trip'), type: LinkType.Dir } },
      { path: ['Trip', 'Sea view.JPG'], entry: file('Sea view.JPG', { modified_at: at(2026, 10, 1) }) },
      { path: ['Trip', 'clip.mov'], entry: file('clip.mov') },
      { path: ['notes.txt'], entry: file('notes.txt') },
      { path: ['logo.svg'], entry: file('logo.svg') },
    ];
    const photos = photosFound({ scope: 'share-1', label: 'Holiday', cid: cidOf(1), shared: true }, found);
    expect(photos.map((p) => [p.name, p.href, p.where, p.video, p.modified, p.shared])).toEqual([
      ['Sea view.JPG', '#/share-1/main/Trip/Sea%20view.JPG', 'Holiday / Trip', false, at(2026, 10, 1), true],
      ['clip.mov', '#/share-1/main/Trip/clip.mov', 'Holiday / Trip', true, null, true],
    ]);
  });
});

describe('where Photos uploads', () => {
  it('is the Photos folder of My Drive, or the shared folder it became', () => {
    expect(photosUploadPlace('me', 'me', [])).toEqual({ scope: 'me', path: ['Photos'] });
    const records = [
      { share_id: 'with-me', local_profile_id: 'me', folder: { owner_profile_id: 'other', source_path: 'Photos' } },
      { share_id: 'mine', local_profile_id: 'me', folder: { owner_profile_id: 'me', source_path: 'Photos' } },
    ] as unknown as AcceptedShareRecord[];
    expect(photosUploadPlace('me', 'me', records)).toEqual({ scope: 'mine', path: [] });
  });
});
