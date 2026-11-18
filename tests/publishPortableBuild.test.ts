import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPlan } from '../scripts/publish-iris-build.mjs';

describe('publish-iris-build', () => {
  beforeEach(() => {
    vi.stubEnv('IRIS_NATIVE_RELEASE_GATE', fileURLToPath(new URL('../scripts/release-site.mjs', import.meta.url)));
    vi.stubEnv('HTREE_BIN', 'htree');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('supports the drive portable publish plan', () => {
    expect(createPublishPlan('drive')).toMatchObject({
      name: 'drive',
      appName: 'Iris Drive',
      distDir: 'dist',
      treeName: 'drive',
    });
  });

  it('publishes the selected tree name from the matching dist directory', () => {
    const { command, distPath } = createPublishPlan('drive');
    expect(command).toEqual([
      process.execPath,
      process.env.IRIS_NATIVE_RELEASE_GATE,
      '--dist',
      distPath,
      '--tree',
      'drive',
      '--htree',
      'htree',
    ]);

    expect(createPublishPlan('drive').distDir).toMatch(/dist$/);
  });
});
