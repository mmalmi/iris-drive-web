import { describe, expect, it } from 'vitest';
import { drivePlaces } from '../src/lib/drivePlaces';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SHARED = '33333333-3333-4333-8333-333333333333';
const records = [{
  share_id: SHARED,
  local_profile_id: ME,
  folder: { owner_profile_id: OTHER, display_name: 'Trip' },
}] as unknown as AcceptedShareRecord[];

const active = (path: string) => drivePlaces(path, `#/${ME}/main`, records).filter((place) => place.active).map((place) => place.label);

describe('the place a page belongs to', () => {
  it('is My Drive for this Drive, Shared with me for a folder shared with it', () => {
    expect(active(`/${ME}/main/Photos`)).toEqual(['My Drive']);
    expect(active(`/${SHARED}/main`)).toEqual(['Shared with me']);
    expect(active('/trash')).toEqual(['Trash']);
    expect(active('/recent')).toEqual(['Recent']);
    expect(active('/photos')).toEqual(['Photos']);
  });

  it('are My Drive, Recent, Photos Shared with me and Trash, in that order', () => {
    expect(drivePlaces('/photos', `#/${ME}/main`, records).map((place) => place.href)).toEqual([`#/${ME}/main`, '#/recent', '#/photos', '#/shared-with-me', '#/trash']);
  });

  it('is none for a Drive or folder this account has no access to', () => {
    expect(active(`/${OTHER}/main`)).toEqual([]);
    expect(drivePlaces(`/${OTHER}/main`, '#/', []).filter((place) => place.active)).toEqual([]);
  });
});
