import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePublishOutput, releaseProfiles } from './release-site.mjs';
import { resolveHtreeCommand } from './hashtreePaths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

export function createPublishPlan(profileName) {
  const profile = releaseProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown publish profile: ${profileName}`);
  }

  return {
    name: profile.name,
    appName: profile.appName,
    treeName: profile.treeName,
    distDir: profile.distDir,
    distPath: path.join(appDir, profile.distDir),
    command: resolveHtreeCommand('add', '.', '--publish', profile.treeName),
  };
}

function defaultRunner(plan) {
  const [command, ...args] = plan.command;
  const result = spawnSync(command, args, {
    cwd: plan.distPath,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runPublish(profileName, runner = defaultRunner) {
  const plan = createPublishPlan(profileName);
  const result = runner(plan);
  if (result.status !== 0) {
    throw new Error(`Publish ${plan.appName} failed with exit code ${result.status}`);
  }

  return {
    ...plan,
    publish: parsePublishOutput(`${result.stdout}\n${result.stderr}`),
  };
}

export function printPublishSummary(result) {
  console.log(`Portable ${result.appName} immutable URL: htree://${result.publish.nhash}/index.html`);
  console.log(`Portable ${result.appName} mutable URL: htree://${result.publish.publishedRef}`);
  console.log(`Portable ${result.appName} owner URL: htree://${result.publish.publishedRef}`);
}

export function publishProfileFromCli(profileName) {
  try {
    printPublishSummary(runPublish(profileName));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
