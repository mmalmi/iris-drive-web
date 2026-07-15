export interface SequentialStreamWriter {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  abort(reason?: unknown): void;
  dispose(): void;
}

interface StreamWriterLike {
  write(chunk: Uint8Array): Promise<unknown>;
  close(): Promise<unknown>;
  abort(reason?: unknown): Promise<unknown>;
}

interface SequentialStreamWriterOptions {
  writer: StreamWriterLike;
  inactivityTimeoutMs?: number;
  timeoutMessage?: string;
  onTimeout?: (error: Error) => void;
  onError?: (error: unknown) => void;
  onClosed?: () => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createSequentialStreamWriter(options: SequentialStreamWriterOptions): SequentialStreamWriter {
  const {
    writer,
    inactivityTimeoutMs = 0,
    timeoutMessage = 'Timed out waiting for stream data',
    onTimeout,
    onError,
    onClosed,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let writeChain: Promise<unknown> = Promise.resolve();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let accepting = true;
  let closed = false;

  const clearInactivityTimer = () => {
    if (timeoutId !== null) {
      clearTimeoutFn(timeoutId);
      timeoutId = null;
    }
  };

  const settleClosed = () => {
    if (closed) return;
    closed = true;
    clearInactivityTimer();
    onClosed?.();
  };

  const abortWith = (reason?: unknown) => {
    if (closed) return;
    accepting = false;
    clearInactivityTimer();
    void writer.abort(reason).catch(() => {}).finally(settleClosed);
  };

  const fail = (error: unknown) => {
    if (closed) return;
    onError?.(error);
    abortWith(error);
  };

  const armInactivityTimer = () => {
    if (inactivityTimeoutMs <= 0 || closed || !accepting) return;
    clearInactivityTimer();
    timeoutId = setTimeoutFn(() => {
      const error = new Error(timeoutMessage);
      onTimeout?.(error);
      abortWith(error);
    }, inactivityTimeoutMs);
  };

  return {
    enqueue(chunk: Uint8Array) {
      if (closed || !accepting) return;
      armInactivityTimer();
      writeChain = writeChain
        .then(() => {
          if (closed) return undefined;
          return writer.write(chunk);
        })
        .catch(fail);
    },

    close() {
      if (closed || !accepting) return;
      accepting = false;
      clearInactivityTimer();
      writeChain
        .then(() => {
          if (closed) return undefined;
          return writer.close();
        })
        .then(settleClosed)
        .catch(fail);
    },

    abort(reason?: unknown) {
      abortWith(reason);
    },

    dispose() {
      clearInactivityTimer();
    },
  };
}
