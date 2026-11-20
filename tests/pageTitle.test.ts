import { describe, expect, it } from 'vitest';
import { nhashEncode } from '@hashtree/core';
import { pageTitle } from '../src/lib/pageTitle';
import { parseRouteFromHash } from '../src/utils/route';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SHARED = '33333333-3333-4333-8333-333333333333';
const shares = [{ share_id: SHARED, folder: { display_name: 'Trip' } }] as unknown as AcceptedShareRecord[];
const NHASH = nhashEncode('ab'.repeat(32));

/** The tab's title at an address, as App works it out. */
function title(hash: string, myDrive: string | null = ME): string {
  const path = hash.slice(1).split('?')[0] || '/';
  return pageTitle(path, parseRouteFromHash(hash), myDrive, shares);
}

describe('the tab title', () => {
  it('names Drive\'s places as Google Drive does', () => {
    expect(title(`#/${ME}/main`)).toBe('My Drive - Iris Drive');
    expect(title('#/recent')).toBe('Recent - Iris Drive');
    expect(title('#/photos')).toBe('Photos - Iris Drive');
    expect(title('#/photos/albums')).toBe('Photos - Iris Drive');
    expect(title('#/shared-with-me')).toBe('Shared with me - Iris Drive');
    expect(title('#/trash')).toBe('Trash - Iris Drive');
    expect(title(`#/${ME}/trash`)).toBe('Trash - Iris Drive');
    expect(title('#/settings/storage')).toBe('Storage - Iris Drive');
    expect(title('#/settings')).toBe('Settings - Iris Drive');
    expect(title('#/settings/network/servers')).toBe('Settings - Iris Drive');
  });

  it('names the open folder, file or document', () => {
    expect(title(`#/${ME}/main/Taxes/2026`)).toBe('2026 - Iris Drive');
    expect(title(`#/${ME}/main/Taxes/Receipt%20%231.pdf`)).toBe('Receipt #1.pdf - Iris Drive');
    expect(title(`#/${ME}/main/Plans.irisdoc`)).toBe('Plans - Iris Drive');
    expect(title(`#/${ME}/main/Budget.irissheet`)).toBe('Budget - Iris Drive');
    expect(title(`#/${SHARED}/main/Slides.irisslides`)).toBe('Slides - Iris Drive');
  });

  it('names a shared folder by the name it was shared under', () => {
    expect(title(`#/${SHARED}/main`)).toBe('Trip - Iris Drive');
    expect(title(`#/${SHARED}/main/Day%201`)).toBe('Day 1 - Iris Drive');
  });

  it('names a read-only copy by the name its link carries', () => {
    expect(title(`#/${NHASH}?name=Holiday`)).toBe('Holiday - Iris Drive');
    expect(title(`#/${NHASH}/notes.txt`)).toBe('notes.txt - Iris Drive');
    expect(title(`#/${NHASH}?snapshot=1&doc=Minutes&kind=sheet`)).toBe('Minutes - Iris Drive');
  });

  it('names a photo album after its folder', () => {
    expect(title(`#/photos/album/${ME}/Photos/Summer`)).toBe('Summer - Iris Drive');
    expect(title(`#/photos/album/${SHARED}`)).toBe('Trip - Iris Drive');
  });

  it('names sign-in pages by their headings', () => {
    expect(title('#/users')).toBe('Profiles - Iris Drive');
    expect(title('#/users/existing')).toBe('Sign in - Iris Drive');
    expect(title('#/users/create')).toBe('Create profile - Iris Drive');
  });

  it('is the app alone where nothing has a name to show', () => {
    expect(title('#/')).toBe('Iris Drive');
    expect(title('#/', null)).toBe('Iris Drive');
    expect(title(`#/${OTHER}/main`)).toBe('Iris Drive');
    expect(title(`#/${NHASH}`)).toBe('Iris Drive');
    expect(title(`#/${ME}/profile`)).toBe('Iris Drive');
    expect(title('#/share-join/abc')).toBe('Iris Drive');
  });
});
