export function conflictPath(originalPath: string, appKeyLabel: string): string {
  const splitAt = originalPath.lastIndexOf('/');
  const directory = splitAt >= 0 ? originalPath.slice(0, splitAt + 1) : '';
  const name = splitAt >= 0 ? originalPath.slice(splitAt + 1) : originalPath;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = truncateUtf8(hasExtension ? name.slice(dot) : '', 48);
  const markerPrefix = ' (conflict from ';
  const markerSuffix = ')';
  const fixedBytes = byteLength(markerPrefix) + byteLength(markerSuffix) + byteLength(extension);
  const available = Math.max(0, 240 - fixedBytes);
  const label = truncateUtf8(appKeyLabel, Math.min(
    byteLength(appKeyLabel),
    Math.max(0, available - 1),
  ));
  const truncatedStem = truncateUtf8(stem, Math.max(0, available - byteLength(label)));
  return `${directory}${truncatedStem}${markerPrefix}${label}${markerSuffix}${extension}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = '';
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (resultBytes + characterBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
