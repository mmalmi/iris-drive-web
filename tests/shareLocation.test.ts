import { describe, expect, it } from 'vitest';
import { isOwnShare } from '../src/drive/shareLibrary';
import { shareLocation } from '../src/drive/shareScope';
import type { SharedFolder } from '../src/drive/protocol';

const me = '11111111-1111-4111-8111-111111111111';
const someone = '22222222-2222-4222-8222-222222222222';

function record(owner: string, sourcePath: string) {
  return {
    local_profile_id: me,
    folder: { owner_profile_id: owner, source_path: sourcePath } as SharedFolder,
  };
}

describe('where a shared folder sits', () => {
  it('keeps a folder this profile shared in My Drive, under the folders above it', () => {
    expect(isOwnShare(record(me, 'Projects/Trip 2026'))).toBe(true);
    expect(shareLocation(record(me, 'Projects/Trip 2026'))).toEqual([
      { name: 'My Drive', href: `#/${me}/main` },
      { name: 'Projects', href: `#/${me}/main/Projects` },
    ]);
    expect(shareLocation(record(me, 'Trip 2026'))).toEqual([{ name: 'My Drive', href: `#/${me}/main` }]);
  });

  it('puts a folder someone else shared under Shared with me', () => {
    expect(isOwnShare(record(someone, 'Trip'))).toBe(false);
    expect(shareLocation(record(someone, 'Trip'))).toEqual([{ name: 'Shared with me', href: '#/shared-with-me' }]);
  });

  it('encodes folder names in the links', () => {
    expect(shareLocation(record(me, 'A & B/Trip'))[1]).toEqual({ name: 'A & B', href: `#/${me}/main/A%20%26%20B` });
  });
});
