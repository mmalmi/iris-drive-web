import { describe, expect, it } from 'vitest';
import { createPublishPlan } from '../scripts/publish-iris-build.mjs';

describe('publish-iris-build', () => {
  it('supports the drive portable publish plan', () => {
    expect(createPublishPlan('drive')).toMatchObject({
      name: 'drive',
      appName: 'Iris Drive',
      distDir: 'dist',
      treeName: 'drive',
    });
  });

  it('publishes the selected tree name from the matching dist directory', () => {
    const command = createPublishPlan('drive').command;
    expect(command.slice(-4)).toEqual(['add', '.', '--publish', 'drive']);
    expect(command).toEqual([
      process.env.HTREE_BIN || 'htree',
      'add',
      '.',
      '--publish',
      'drive',
    ]);

    expect(createPublishPlan('drive').distDir).toMatch(/dist$/);
  });
});
