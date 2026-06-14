import { toast } from './toast';

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
  let toastShown = false;
  const timeoutId = setTimeout(() => {
    toastShown = true;
    toast.warning(message);
  }, STALL_TIMEOUT_MS);

  try {
    return await operation;
  } finally {
    clearTimeout(timeoutId);
    if (toastShown) {
      toast.success('Operation resumed');
    }
  }
}
