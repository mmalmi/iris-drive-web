import { dismissToast, showToast, toast } from './toast';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogv', '.3gp']);
const STALL_TIMEOUT_MS = 10000;

export function isVideoFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return VIDEO_EXTENSIONS.has(ext);
}

export async function withStallDetection<T>(
  operation: Promise<T>,
  message: string,
): Promise<T> {
  // The notice stays for as long as the wait does: one that left after a few
  // seconds made a long wait look like nothing was wrong.
  let noticeId: string | null = null;
  const timeoutId = setTimeout(() => {
    noticeId = showToast('warning', message, 0);
  }, STALL_TIMEOUT_MS);

  try {
    return await operation;
  } finally {
    clearTimeout(timeoutId);
    if (noticeId !== null) {
      dismissToast(noticeId);
      toast.success('Operation resumed');
    }
  }
}
