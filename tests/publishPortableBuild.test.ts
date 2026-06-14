import { describe, expect, it } from 'vitest';
import { createPublishPlan } from '../scripts/publish-iris-build.mjs';

describe('publish-iris-build', () => {
  it('supports the drive portable publish plan', () => {
    expect(createPublishPlan('drive')).toMatchObject({
      name: 'drive',
      appName: 'iris drive',
      distDir: 'dist',
      treeName: 'drive',
    });
  });

  it('publishes the selected tree name from the matching dist directory', () => {
    const command = createPublishPlan('drive').command;
    expect(command.slice(-4)).toEqual(['add', '.', '--publish', 'drive']);

    if (command[0] === 'cargo') {
      expect(command).toEqual([
        'cargo',
        'run',
        '--manifest-path',
        expect.stringContaining('/rust/Cargo.toml'),
        '-p',
        'hashtree-cli',
        '--bin',
        'htree',
        '--',
        'add',
        '.',
        '--publish',
        'drive',
      ]);
    } else {
      expect(command).toEqual(['htree', 'add', '.', '--publish', 'drive']);
    }

    expect(createPublishPlan('drive').distDir).toMatch(/dist$/);
  });
});
