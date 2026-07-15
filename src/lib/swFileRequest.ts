export interface FileRequest {
  type: 'hashtree-file';
  requestId: string;
  npub?: string;
  nhash?: string;
  treeName?: string;
  path: string;
  start: number;
  end?: number;
  rangeHeader?: string | null;
  mimeType: string;
  download?: boolean;
}

function parseRangeHeader(rangeHeader: string | null): { start: number; end?: number } {
  if (!rangeHeader) {
    return { start: 0 };
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    return { start: 0 };
  }

  return {
    start: match[1] ? parseInt(match[1], 10) : 0,
    end: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

interface MutableFileRequestInput {
  requestId: string;
  npub: string;
  treeName: string;
  filePath: string;
  rangeHeader: string | null;
  mimeType: string;
  forceDownload: boolean;
}

export function buildMutableFileRequest(input: MutableFileRequestInput): FileRequest {
  const { start, end } = parseRangeHeader(input.rangeHeader);
  return {
    type: 'hashtree-file',
    requestId: input.requestId,
    npub: input.npub,
    treeName: input.treeName,
    path: input.filePath,
    start,
    end,
    rangeHeader: input.rangeHeader,
    mimeType: input.mimeType,
    download: input.forceDownload,
  };
}

interface ImmutableFileRequestInput {
  requestId: string;
  nhash: string;
  filePath: string;
  rangeHeader: string | null;
  mimeType: string;
  forceDownload: boolean;
}

export function buildImmutableFileRequest(input: ImmutableFileRequestInput): FileRequest {
  const { start, end } = parseRangeHeader(input.rangeHeader);
  return {
    type: 'hashtree-file',
    requestId: input.requestId,
    nhash: input.nhash,
    path: input.filePath,
    start,
    end,
    rangeHeader: input.rangeHeader,
    mimeType: input.mimeType,
    download: input.forceDownload,
  };
}
