import { describe, expect, it } from 'vitest';
import {
  buildMutableFileRequest,
  buildImmutableFileRequest,
} from '../src/lib/swFileRequest';

describe('service worker file request builders', () => {
  it('marks mutable npub requests as downloads when requested', () => {
    expect(buildMutableFileRequest({
      requestId: 'file_1',
      npub: 'npub1example',
      treeName: 'releases/example',
      filePath: 'v1.0.0/assets/example.tar.gz',
      rangeHeader: null,
      mimeType: 'application/gzip',
      forceDownload: true,
    })).toMatchObject({
      type: 'hashtree-file',
      requestId: 'file_1',
      npub: 'npub1example',
      treeName: 'releases/example',
      path: 'v1.0.0/assets/example.tar.gz',
      start: 0,
      mimeType: 'application/gzip',
      download: true,
    });
  });

  it('preserves byte ranges for immutable nhash requests', () => {
    expect(buildImmutableFileRequest({
      requestId: 'file_2',
      nhash: 'nhash1example',
      filePath: 'example.tar.gz',
      rangeHeader: 'bytes=128-255',
      mimeType: 'application/gzip',
      forceDownload: false,
    })).toMatchObject({
      type: 'hashtree-file',
      requestId: 'file_2',
      nhash: 'nhash1example',
      path: 'example.tar.gz',
      start: 128,
      end: 255,
      rangeHeader: 'bytes=128-255',
      mimeType: 'application/gzip',
      download: false,
    });
  });
});
