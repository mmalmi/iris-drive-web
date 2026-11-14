/**
 * When a JPEG photo was taken, from the EXIF data cameras and phones write at
 * the start of the file: DateTimeOriginal, or DateTimeDigitized, or the
 * file's DateTime. The first 64 KB or so of the file is enough.
 */

const EXIF_IFD_POINTER = 0x8769;
const DATE_TIME = 0x0132;
const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const OFFSET_TIME_ORIGINAL = 0x9011;
const ASCII = 2;
const LONG = 4;

/** How many bytes from the start of a JPEG file to read for its date. */
export const EXIF_READ_BYTES = 128 * 1024;

export function isJpegName(name: string): boolean {
  return /\.(jpe?g|jfif)$/i.test(name);
}

/** The time a JPEG was taken in Unix seconds, or null when it says none. */
export function exifTakenAt(bytes: Uint8Array): number | null {
  try {
    const tiff = findExif(bytes);
    return tiff ? takenAt(tiff) : null;
  } catch {
    return null;
  }
}

/** The TIFF data inside the JPEG's EXIF segment. */
function findExif(bytes: Uint8Array): DataView | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Padding before a marker.
    if (marker === 0xff) { offset += 1; continue; }
    // The picture itself starts; no EXIF came before it.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    const start = offset + 4;
    if (marker === 0xe1 && start + 6 <= bytes.length && text(bytes, start, 6) === 'Exif\0\0') {
      const end = Math.min(offset + 2 + length, bytes.length);
      return new DataView(bytes.buffer, bytes.byteOffset + start + 6, end - start - 6);
    }
    offset += 2 + length;
  }
  return null;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

interface Tag { type: number; count: number; valueAt: number }

function takenAt(tiff: DataView): number | null {
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return null;

  const tags = (ifd: number): Map<number, Tag> => {
    const found = new Map<number, Tag>();
    if (ifd <= 0 || ifd + 2 > tiff.byteLength) return found;
    const count = tiff.getUint16(ifd, little);
    for (let i = 0; i < count; i += 1) {
      const at = ifd + 2 + i * 12;
      if (at + 12 > tiff.byteLength) break;
      const type = tiff.getUint16(at + 2, little);
      const length = tiff.getUint32(at + 4, little);
      // Values of up to four bytes are in the entry itself; longer ones elsewhere.
      const valueAt = type === ASCII && length > 4 ? tiff.getUint32(at + 8, little) : at + 8;
      found.set(tiff.getUint16(at, little), { type, count: length, valueAt });
    }
    return found;
  };
  const ascii = (tag: Tag | undefined): string | null => {
    if (!tag || tag.type !== ASCII || tag.valueAt + tag.count > tiff.byteLength) return null;
    let value = '';
    for (let i = 0; i < tag.count; i += 1) {
      const code = tiff.getUint8(tag.valueAt + i);
      if (code === 0) break;
      value += String.fromCharCode(code);
    }
    return value;
  };

  const top = tags(tiff.getUint32(4, little));
  const pointer = top.get(EXIF_IFD_POINTER);
  const exif = pointer && pointer.type === LONG ? tags(tiff.getUint32(pointer.valueAt, little)) : new Map<number, Tag>();
  const offset = ascii(exif.get(OFFSET_TIME_ORIGINAL));
  return parseExifDate(ascii(exif.get(DATE_TIME_ORIGINAL)), offset)
    ?? parseExifDate(ascii(exif.get(DATE_TIME_DIGITIZED)), null)
    ?? parseExifDate(ascii(top.get(DATE_TIME)), null);
}

/**
 * `2026:11:12 14:05:33` in Unix seconds: at the given offset such as
 * `+02:00`, or in this device's time zone when there is none, as cameras
 * mostly write it.
 */
export function parseExifDate(value: string | null, offset: string | null): number | null {
  const match = value?.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const zone = offset?.trim().match(/^([+-])(\d{2}):(\d{2})$/);
  if (zone) {
    const minutes = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === '-' ? -1 : 1);
    return Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - minutes * 60;
  }
  return Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);
}
