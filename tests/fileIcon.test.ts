import { describe, expect, it } from 'vitest';
import { getFileIcon } from '@iris/hashtree-app/fileIcon';

describe('getFileIcon', () => {
  it('treats DOS executables like generic files', () => {
    expect(getFileIcon('GAME.EXE')).toBe('i-lucide-file');
    expect(getFileIcon('launcher.com')).toBe('i-lucide-file');
  });
});
