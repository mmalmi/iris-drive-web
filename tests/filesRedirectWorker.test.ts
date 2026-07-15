import { describe, expect, it } from 'vitest';
import worker from '../scripts/files-redirect-worker.mjs';

describe('files.iris.to redirect worker', () => {
  it('redirects legacy files.iris.to requests to drive.iris.to while preserving path and query', async () => {
    const response = await worker.fetch(
      new Request('https://files.iris.to/share?path=%2FShared%20Source'),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://drive.iris.to/share?path=%2FShared%20Source');
  });
});
