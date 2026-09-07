import { describe, expect, it, vi } from 'vitest';
import {
  createReleasePlan,
  parseArgs,
  parsePublishOutput,
  runAllReleases,
  runRelease,
  wranglerVersion,
} from '../scripts/release-site.mjs';
import {
  configFor as workerAssetsConfigFor,
  parseArgs as parseWorkerAssetsArgs,
} from '../scripts/deploy-worker-assets.mjs';

describe('release-site', () => {
  const wranglerCommand = `wrangler@${wranglerVersion}`;

  it('uses the built-in Worker default for drive', () => {
    const parsed = parseArgs(['drive']);
    expect(parsed.workerName).toBe('iris-drive');
    expect(parsed.treeName).toBe('drive');
    expect(parsed.routes).toEqual(['drive.iris.to/*']);
    expect(parsed.domains).toEqual([]);
  });

  it('keeps the built-in Worker default for legacy files', () => {
    const parsed = parseArgs(['files']);
    expect(parsed.workerName).toBe('iris-files');
    expect(parsed.treeName).toBe('files');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('lets an explicit Worker env var override the built-in drive default', () => {
    const parsed = parseArgs(['drive'], { CF_WORKER_NAME_DRIVE: 'iris-drive-staging' });
    expect(parsed.workerName).toBe('iris-drive-staging');
    expect(parsed.routes).toEqual([]);
  });

  it('supports explicitly switching a profile back to Pages', () => {
    const parsed = parseArgs(['drive', '--pages-only'], { CF_PAGES_PROJECT_DRIVE: 'drive-iris-to' });
    expect(parsed.workerName).toBeUndefined();
    expect(parsed.pagesProject).toBe('drive-iris-to');
    expect(parsed.routes).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  it('supports the all profile without per-site overrides', () => {
    const parsed = parseArgs(['all', '--branch', 'main', '--skip-cloudflare']);
    expect(parsed.profileName).toBe('all');
    expect(parsed.branch).toBe('main');
    expect(parsed.skipCloudflare).toBe(true);
  });

  it('rejects single-target Worker overrides for the all profile', () => {
    expect(() => parseArgs(['all', '--worker-name', 'iris-files'])).toThrow(
      '--worker-name is not supported with the all profile',
    );
  });

  it('supports drive release profiles', () => {
    const drive = createReleasePlan({
      profileName: 'drive',
      pagesProject: 'drive-iris-to',
      treeName: 'drive',
      skipCloudflare: false,
    });

    expect(drive.profile.distDir).toBe('dist');
  });

  it('builds a Worker release plan in build-test-publish-deploy order', () => {
    const plan = createReleasePlan({
      profileName: 'drive',
      workerName: 'iris-drive',
      routes: ['drive.iris.to/*'],
      domains: [],
      treeName: 'drive',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.map((step) => step.id)).toEqual([
      'build',
      'test-1',
      'test-2',
      'test-3',
      'test-4',
      'test-5',
      'test-6',
      'publish',
      'deploy',
    ]);
    expect(plan.steps.find((step) => step.id === 'test-1')?.command).toEqual([
      'node',
      './scripts/verify-htree-cli.mjs',
    ]);
    expect(plan.steps.find((step) => step.id === 'test-3')?.command).toEqual([
      'pnpm',
      'run',
      'check',
    ]);
    expect(plan.steps.at(-1)?.command).toEqual([
      'node',
      './scripts/deploy-worker-assets.mjs',
      '--script',
      'scripts/https-static-assets-worker.mjs',
      '--assets',
      'dist',
      '--name',
      'iris-drive',
      '--compatibility-date',
      '2026-03-19',
      '--wrangler-version',
      wranglerVersion,
      '--route',
      'drive.iris.to/*',
    ]);
  });

  it('generates a Worker Static Assets config that runs the redirect Worker first', () => {
    const options = parseWorkerAssetsArgs([
      '--script',
      'scripts/https-static-assets-worker.mjs',
      '--assets',
      'dist',
      '--name',
      'iris-drive',
      '--compatibility-date',
      '2026-03-19',
    ]);

    expect(workerAssetsConfigFor(options)).toEqual({
      name: 'iris-drive',
      compatibility_date: '2026-03-19',
      main: 'scripts/https-static-assets-worker.mjs',
      assets: {
        directory: 'dist',
        binding: 'ASSETS',
        run_worker_first: true,
      },
    });
  });

  it('prefers a Worker deployment when both Worker and Pages targets are configured', () => {
    const plan = createReleasePlan({
      profileName: 'drive',
      workerName: 'iris-drive',
      pagesProject: 'files-iris-to',
      treeName: 'drive',
      skipCloudflare: false,
      workerCompatibilityDate: '2026-03-19',
    });

    expect(plan.steps.at(-1)?.label).toBe('Deploy Iris Drive to Cloudflare Worker');
  });

  it('builds a Pages release plan when only a Pages project is configured', () => {
    const plan = createReleasePlan({
      profileName: 'drive',
      pagesProject: 'files-iris-to',
      treeName: 'drive',
      branch: 'main',
      skipCloudflare: false,
    });

    expect(plan.steps.at(-1)?.command).toEqual([
      'npx',
      wranglerCommand,
      'pages',
      'deploy',
      'dist',
      '--project-name',
      'files-iris-to',
      '--branch',
      'main',
    ]);
  });

  it('rejects Pages-only branch flags for Worker deployments', () => {
    expect(() =>
      createReleasePlan({
        profileName: 'drive',
        workerName: 'iris-drive',
        branch: 'preview',
        treeName: 'drive',
        skipCloudflare: false,
      }),
    ).toThrow('--branch is only supported for Pages deployments');
  });

  it('parses hashtree publish output', () => {
    expect(parsePublishOutput('published: npub1owner/drive\nnhash1ace')).toEqual({
      publishedRef: 'npub1owner/drive',
      nhash: 'nhash1ace',
    });
  });

  it('fails when the build step fails', async () => {
    const runner = vi.fn(async (step) => ({
      status: step.id === 'build' ? 1 : 0,
      stdout: '',
      stderr: '',
    }));
    const options = {
      profileName: 'drive',
      workerName: 'iris-drive',
      treeName: 'drive',
      skipCloudflare: false,
    };

    await expect(runRelease(options, runner)).rejects.toThrow('Build Iris Drive failed with exit code 1');
  });

  it('runs all configured release profiles', async () => {
    const runner = vi.fn(async (step) => ({
      status: 0,
      stdout: step.id === 'publish' ? 'published: npub1example/drive\nnhash1ace' : '',
      stderr: '',
    }));

    const result = await runAllReleases(
      { profileName: 'all', skipCloudflare: true },
      runner,
      { buildOutputExists: () => true },
    );
    expect(result.profiles.map((profile) => profile.profile.name)).toEqual(['drive']);
  });
});
