export const defaultWorkerCompatibilityDate = '2026-03-19';
export const wranglerVersion = '4.78.0';

export const releaseProfiles = {
  drive: {
    name: 'drive',
    appName: 'Iris Drive',
    distDir: 'dist',
    treeName: 'drive',
    defaultWorkerName: 'iris-drive',
    defaultRoutes: ['drive.iris.to/*'],
    workerScript: 'scripts/https-static-assets-worker.mjs',
    workerNameEnv: 'CF_WORKER_NAME_DRIVE',
    pagesProjectEnv: 'CF_PAGES_PROJECT_DRIVE',
    buildCommand: ['pnpm', 'run', 'build'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/filesPortableBuildConfig.test.ts', 'tests/shareUrls.test.ts', 'tests/driveHtreeRouteCompatibility.test.ts'],
      ['node', './scripts/smoke-files-iris-portable.mjs'],
      ['pnpm', 'exec', 'playwright', 'test', 'e2e/viewer-actions.spec.ts', '--project=chromium'],
    ],
  },
  files: {
    name: 'files',
    appName: 'Iris Drive',
    distDir: 'dist',
    treeName: 'files',
    defaultWorkerName: 'iris-files',
    workerScript: 'scripts/https-static-assets-worker.mjs',
    workerNameEnv: 'CF_WORKER_NAME_FILES',
    pagesProjectEnv: 'CF_PAGES_PROJECT_FILES',
    buildCommand: ['pnpm', 'run', 'build'],
    testCommands: [
      ['pnpm', 'exec', 'vitest', 'run', 'tests/filesPortableBuildConfig.test.ts', 'tests/shareUrls.test.ts', 'tests/driveHtreeRouteCompatibility.test.ts'],
      ['node', './scripts/smoke-files-iris-portable.mjs'],
      ['pnpm', 'exec', 'playwright', 'test', 'e2e/viewer-actions.spec.ts', '--project=chromium'],
    ],
  },
};

export const releaseProfileNames = ['drive'];
