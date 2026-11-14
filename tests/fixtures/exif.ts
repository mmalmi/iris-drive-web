/** Builds a JPEG's EXIF segment with the dates a camera writes, for tests. */

const ASCII = 2;
const LONG = 4;

interface Field { tag: number; type: number; value: string | number }

export interface ExifDates {
  /** DateTimeOriginal, such as `2025:06:01 12:30:00`. */
  original?: string;
  /** OffsetTimeOriginal, such as `+02:00`. */
  offset?: string;
  /** The file's DateTime. */
  dateTime?: string;
}

function tiff(dates: ExifDates, little: boolean): Uint8Array {
  const top: Field[] = [];
  if (dates.dateTime) top.push({ tag: 0x0132, type: ASCII, value: dates.dateTime });
  const exif: Field[] = [];
  if (dates.original) exif.push({ tag: 0x9003, type: ASCII, value: dates.original });
  if (dates.offset) exif.push({ tag: 0x9011, type: ASCII, value: dates.offset });
  if (exif.length > 0) top.push({ tag: 0x8769, type: LONG, value: 0 });

  const ifdSize = (fields: Field[]) => 2 + fields.length * 12 + 4;
  const topAt = 8;
  const exifAt = topAt + ifdSize(top);
  let dataAt = exifAt + (exif.length > 0 ? ifdSize(exif) : 0);
  const strings = [...top, ...exif].filter((field) => field.type === ASCII).map((field) => `${field.value}\0`);
  const size = dataAt + strings.reduce((sum, value) => sum + value.length, 0);
  const view = new DataView(new ArrayBuffer(size));
  const bytes = new Uint8Array(view.buffer);

  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, topAt, little);
  const writeIfd = (at: number, fields: Field[]) => {
    view.setUint16(at, fields.length, little);
    fields.forEach((field, index) => {
      const entry = at + 2 + index * 12;
      view.setUint16(entry, field.tag, little);
      view.setUint16(entry + 2, field.type, little);
      if (field.type === ASCII) {
        const text = `${field.value}\0`;
        view.setUint32(entry + 4, text.length, little);
        view.setUint32(entry + 8, dataAt, little);
        for (let i = 0; i < text.length; i += 1) bytes[dataAt + i] = text.charCodeAt(i);
        dataAt += text.length;
      } else {
        view.setUint32(entry + 4, 1, little);
        view.setUint32(entry + 8, field.tag === 0x8769 ? exifAt : Number(field.value), little);
      }
    });
    view.setUint32(at + 2 + fields.length * 12, 0, little);
  };
  writeIfd(topAt, top);
  if (exif.length > 0) writeIfd(exifAt, exif);
  return bytes;
}

/** The APP1 segment holding the dates. */
export function exifSegment(dates: ExifDates, little = false): Uint8Array {
  const body = tiff(dates, little);
  const length = 2 + 6 + body.length;
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...[...'Exif\0\0'].map((c) => c.charCodeAt(0)), ...body]);
}

/** A JPEG with the dates put in after its start, where cameras put them. */
export function jpegWithExif(jpeg: Uint8Array, dates: ExifDates, little = false): Uint8Array {
  return new Uint8Array([...jpeg.subarray(0, 2), ...exifSegment(dates, little), ...jpeg.subarray(2)]);
}
