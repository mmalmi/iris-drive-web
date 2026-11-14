import { describe, expect, it } from 'vitest';
import { LinkType, type CID } from '@hashtree/core';
import { arrangePhotos, dateHeading, photosFound, photosUploadPlace, type Photo } from '../src/lib/photos';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const NOW = new Date(2026, 10, 14, 15, 0, 0);
const at = (...parts: [number, number, number, number?]) => new Date(parts[0], parts[1], parts[2], parts[3] ?? 12).getTime() / 1000;
const cidOf = (n: number): CID => ({ hash: new Uint8Array(32).fill(n) });
const heading = (seconds: number | null) => dateHeading(seconds, NOW, 'en-GB').label;

function photo(name: string, modified: number | null, n: number): Photo {
  return { href: `#/me/main/${name}`, name, cid: cidOf(n), hash: String(n).padStart(64, '0'), size: 1, where: 'My Drive', video: false, modified };
}

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
    const taken = new Map([[uploadedToday.hash, at(2025, 6, 1)], [yesterday.hash, null]]);

    const groups = arrangePhotos([undated, old, yesterday, today, uploadedToday], taken, NOW, 'en-GB');
    expect(groups.map((group) => [group.label, group.photos.map((p) => p.name)])).toEqual([
      ['Today', ['today.png']],
      ['Yesterday', ['cat.jpg']],
      ['September 2026', ['old.gif']],
      ['July 2025', ['beach.jpg']],
      ['No date', ['undated.webp']],
    ]);
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
    expect(photos.map((p) => [p.name, p.href, p.where, p.video, p.modified])).toEqual([
      ['Sea view.JPG', '#/share-1/main/Trip/Sea%20view.JPG', 'Holiday / Trip', false, at(2026, 10, 1)],
      ['clip.mov', '#/share-1/main/Trip/clip.mov', 'Holiday / Trip', true, null],
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
