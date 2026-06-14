export const PLAYABLE_MEDIA_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.avi',
  '.m4v',
  '.ogv',
  '.3gp',
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
] as const;

export const AUDIO_MEDIA_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
] as const;

export const VIDEO_MEDIA_EXTENSIONS = PLAYABLE_MEDIA_EXTENSIONS.filter(
  (extension) => !(AUDIO_MEDIA_EXTENSIONS as readonly string[]).includes(extension)
) as readonly string[];

export const PREFERRED_PLAYABLE_MEDIA_FILENAMES = [
  'video.mp4',
  'video.webm',
  'video.m4v',
  'video.mov',
  'video.mkv',
  'video.avi',
  'video.ogv',
  'video.3gp',
  'video.mp3',
  'video.m4a',
  'video.aac',
  'video.ogg',
  'video.oga',
  'video.opus',
  'video.wav',
  'video.flac',
] as const;

const PLAYABLE_MEDIA_EXTENSION_SET = new Set<string>(PLAYABLE_MEDIA_EXTENSIONS);
const AUDIO_MEDIA_EXTENSION_SET = new Set<string>(AUDIO_MEDIA_EXTENSIONS);
const VIDEO_MEDIA_EXTENSION_SET = new Set<string>(VIDEO_MEDIA_EXTENSIONS);

function normalizeMediaName(name: string): string {
  return name.trim().toLowerCase();
}

function getMediaPreference(name: string): number {
  const normalized = normalizeMediaName(name);
  const preferredIndex = PREFERRED_PLAYABLE_MEDIA_FILENAMES.indexOf(
    normalized as (typeof PREFERRED_PLAYABLE_MEDIA_FILENAMES)[number]
  );
  if (preferredIndex !== -1) {
    return preferredIndex;
  }

  const extensionIndex = PLAYABLE_MEDIA_EXTENSIONS.findIndex((extension) => normalized.endsWith(extension));
  if (extensionIndex !== -1) {
    return PREFERRED_PLAYABLE_MEDIA_FILENAMES.length + extensionIndex;
  }

  return Number.POSITIVE_INFINITY;
}

export function isPlayableMediaFileName(name: string): boolean {
  const normalized = normalizeMediaName(name);
  if (!normalized || normalized.endsWith('/')) {
    return false;
  }
  if (normalized.startsWith('video.')) {
    return true;
  }

  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1) {
    return false;
  }
  return PLAYABLE_MEDIA_EXTENSION_SET.has(normalized.slice(lastDot));
}

export function isAudioMediaFileName(name: string): boolean {
  const normalized = normalizeMediaName(name);
  if (!normalized || normalized.endsWith('/')) {
    return false;
  }
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1) {
    return false;
  }
  return AUDIO_MEDIA_EXTENSION_SET.has(normalized.slice(lastDot));
}

export function isVideoMediaFileName(name: string): boolean {
  const normalized = normalizeMediaName(name);
  if (!normalized || normalized.endsWith('/')) {
    return false;
  }
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1) {
    return false;
  }
  return VIDEO_MEDIA_EXTENSION_SET.has(normalized.slice(lastDot));
}

export function findPlayableMediaEntry<T extends { name: string }>(entries: T[]): T | undefined {
  const playableEntries = entries.filter((entry) => isPlayableMediaFileName(entry.name));
  if (playableEntries.length === 0) {
    return undefined;
  }

  return [...playableEntries].sort((a, b) => {
    const preferenceDiff = getMediaPreference(a.name) - getMediaPreference(b.name);
    if (preferenceDiff !== 0) {
      return preferenceDiff;
    }
    return a.name.localeCompare(b.name);
  })[0];
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function sniffPlayableMediaExtension(bytes: Uint8Array): string | null {
  if (!bytes.length) return null;

  if (
    bytes.length >= 12 &&
    readAscii(bytes, 4, 8) === 'ftyp'
  ) {
    const brand = readAscii(bytes, 8, 12).toLowerCase();
    if (brand.startsWith('m4a')) return '.m4a';
    if (brand.startsWith('qt')) return '.mov';
    return '.mp4';
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const lowerHeader = readAscii(bytes, 0, Math.min(bytes.length, 64)).toLowerCase();
    return lowerHeader.includes('webm') ? '.webm' : '.mkv';
  }

  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'OggS') {
    return '.ogg';
  }

  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'fLaC') {
    return '.flac';
  }

  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readAscii(bytes, 8, 12) === 'WAVE'
  ) {
    return '.wav';
  }

  if (bytes.length >= 3 && readAscii(bytes, 0, 3) === 'ID3') {
    return '.mp3';
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return '.aac';
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return '.mp3';
  }

  return null;
}

export function buildSyntheticPlayableMediaFileName(bytes: Uint8Array): string | null {
  const extension = sniffPlayableMediaExtension(bytes);
  return extension ? `video${extension}` : null;
}
