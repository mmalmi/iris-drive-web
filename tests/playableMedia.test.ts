import { describe, expect, it } from 'vitest';

import {
  AUDIO_MEDIA_EXTENSIONS,
  buildSyntheticPlayableMediaFileName,
  findPlayableMediaEntry,
  isAudioMediaFileName,
  isPlayableMediaFileName,
  sniffPlayableMediaExtension,
} from '../src/lib/playableMedia';

describe('playable media detection', () => {
  it('treats audio-first legacy uploads as playable media', () => {
    expect(isPlayableMediaFileName('video.mp3')).toBe(true);
    expect(isPlayableMediaFileName('video.m4a')).toBe(true);
    expect(isPlayableMediaFileName('soundtrack.ogg')).toBe(true);
    expect(isPlayableMediaFileName('cover.jpg')).toBe(false);
    expect(isPlayableMediaFileName('metadata.json')).toBe(false);
  });

  it('finds playable audio files when no video container is present', () => {
    const entry = findPlayableMediaEntry([
      { name: 'thumbnail.jpg' },
      { name: 'metadata.json' },
      { name: 'video.mp3' },
    ]);

    expect(entry?.name).toBe('video.mp3');
  });

  it('prefers canonical video.* media files over unrelated media names', () => {
    const entry = findPlayableMediaEntry([
      { name: 'full-album.ogg' },
      { name: 'video.m4a' },
      { name: 'thumbnail.jpg' },
    ]);

    expect(entry?.name).toBe('video.m4a');
  });

  it('sniffs playable media extensions from file headers for direct-root media', () => {
    const mp4Header = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
    ]);
    const oggHeader = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    const waveHeader = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ]);

    expect(sniffPlayableMediaExtension(mp4Header)).toBe('.mp4');
    expect(sniffPlayableMediaExtension(oggHeader)).toBe('.ogg');
    expect(sniffPlayableMediaExtension(waveHeader)).toBe('.wav');
    expect(buildSyntheticPlayableMediaFileName(mp4Header)).toBe('video.mp4');
  });

  it('classifies audio extensions separately so audio roots avoid video-only rendering paths', () => {
    expect(AUDIO_MEDIA_EXTENSIONS).toContain('.flac');
    expect(isAudioMediaFileName('video.flac')).toBe(true);
    expect(isAudioMediaFileName('video.mp4')).toBe(false);
  });
});
