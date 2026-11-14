import { describe, expect, it } from 'vitest';
import { exifTakenAt, isJpegName, parseExifDate } from '../src/lib/exif';
import { jpegWithExif } from './fixtures/exif';

/** The start and end of a JPEG with a JFIF segment, as most files begin. */
const JFIF = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const local = (...parts: [number, number, number, number, number, number]) => new Date(...parts).getTime() / 1000;

describe('when a JPEG was taken', () => {
  it('is the camera\'s DateTimeOriginal, in this device\'s time zone when it gives none', () => {
    const bytes = jpegWithExif(JFIF, { original: '2025:06:01 12:30:05', dateTime: '2026:01:01 00:00:00' });
    expect(exifTakenAt(bytes)).toBe(local(2025, 5, 1, 12, 30, 5));
  });

  it('is read in either byte order, at the time zone the camera wrote', () => {
    const bytes = jpegWithExif(JFIF, { original: '2025:06:01 12:30:00', offset: '+02:00' }, true);
    expect(exifTakenAt(bytes)).toBe(Date.UTC(2025, 5, 1, 10, 30, 0) / 1000);
  });

  it('is found after other segments, and falls back to the file\'s DateTime', () => {
    const app0 = JFIF.subarray(0, 20);
    const bytes = jpegWithExif(new Uint8Array([...app0, ...JFIF.subarray(2)]), { dateTime: '2024:12:24 18:00:00' });
    expect(exifTakenAt(bytes)).toBe(local(2024, 11, 24, 18, 0, 0));
  });

  it('is none for a JPEG without one, a blank date, another kind of file or cut-off data', () => {
    expect(exifTakenAt(JFIF)).toBeNull();
    expect(exifTakenAt(jpegWithExif(JFIF, { original: '0000:00:00 00:00:00' }))).toBeNull();
    expect(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeNull();
    expect(exifTakenAt(jpegWithExif(JFIF, { original: '2025:06:01 12:30:00' }).subarray(0, 40))).toBeNull();
  });

  it('reads dates and offsets as cameras write them', () => {
    expect(parseExifDate('2025:13:01 00:00:00', null)).toBeNull();
    expect(parseExifDate('2025:01:31 23:59:59', '-05:00')).toBe(Date.UTC(2025, 1, 1, 4, 59, 59) / 1000);
    expect(isJpegName('IMG_1.JPG')).toBe(true);
    expect(isJpegName('shot.png')).toBe(false);
  });
});
