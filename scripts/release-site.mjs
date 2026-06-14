import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloneValues,
  createDefaultRunner,
  createReleasePlan as createSharedReleasePlan,
  runReleasePlan,
  usesBuiltInWorker,
} from '@iris/release-tools';
import { resolveHtreeCommand } from './hashtreePaths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
import {
  defaultWorkerCompatibilityDate,
  releaseProfileNames,
  releaseProfiles,
  wranglerVersion,
} from './release-profiles.mjs';

export {
  defaultWorkerCompatibilityDate,
  releaseProfileNames,
  releaseProfiles,
  wranglerVersion,
} from './release-profiles.mjs';

export { parsePublishOutput } from '@iris/release-tools';

const defaultRunner = createDefaultRunner();

export function parseArgs(argv, env = process.env) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0));
  const profileName = args.shift();
  if (!profileName || profileName === '-h' || profileName === '--help') {
    return { help: true };
  }

  let pagesProject;
  let workerName;
  let treeName;
  let branch;
  let dryRun = false;
  let skipCloudflare = false;
  let pagesOnly = false;
  const routes = [];
  const domains = [];
  let workerCompatibilityDate;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--') {
      continue;
    }
    if (arg === '--pages-project') {
      pagesProject = args.shift();
      continue;
    }
    if (arg === '--worker-name') {
      workerName = args.shift();
      continue;
    }
    if (arg === '--tree') {
      treeName = args.shift();
      continue;
    }
    if (arg === '--route') {
      routes.push(args.shift());
      continue;
    }
    if (arg === '--domain') {
      domains.push(args.shift());
      continue;
    }
    if (arg === '--branch') {
      branch = args.shift();
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--compatibility-date') {
      workerCompatibilityDate = args.shift();
      continue;
    }
    if (arg === '--skip-cloudflare') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--skip-pages') {
      skipCloudflare = true;
      continue;
    }
    if (arg === '--pages-only') {
      pagesOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (profileName === 'all') {
    if (workerName) {
      throw new Error('--worker-name is not supported with the all profile');
    }
    if (pagesProject) {
      throw new Error('--pages-project is not supported with the all profile');
    }
    if (treeName) {
      throw new Error('--tree is not supported with the all profile');
    }
    if (routes.length > 0) {
      throw new Error('--route is not supported with the all profile');
    }
    if (domains.length > 0) {
      throw new Error('--domain is not supported with the all profile');
    }

    return {
      profileName,
      dryRun,
      skipCloudflare,
      pagesOnly,
      branch,
      workerCompatibilityDate,
    };
  }

  const profile = releaseProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${profileName}`);
  }
  if (pagesOnly && workerName) {
    throw new Error('--pages-only is not compatible with --worker-name');
  }
  if (pagesOnly && (routes.length > 0 || domains.length > 0)) {
    throw new Error('--pages-only is not compatible with --route/--domain');
  }

  const resolvedWorkerName = pagesOnly
    ? undefined
    : workerName ?? env[profile.workerNameEnv] ?? profile.defaultWorkerName;
  const defaultRoutes = usesBuiltInWorker(profile, resolvedWorkerName)
    ? cloneValues(profile.defaultRoutes)
    : [];
  const defaultDomains = usesBuiltInWorker(profile, resolvedWorkerName)
    ? cloneValues(profile.defaultDomains)
    : [];

  return {
    profileName,
    dryRun,
    skipCloudflare,
    branch,
    pagesOnly,
    treeName: treeName ?? profile.treeName,
    workerName: resolvedWorkerName,
    pagesProject: pagesProject ?? env[profile.pagesProjectEnv],
    routes: routes.length > 0 ? routes : defaultRoutes,
    domains: domains.length > 0 ? domains : defaultDomains,
    workerCompatibilityDate:
      workerCompatibilityDate ?? env.CF_WORKER_COMPATIBILITY_DATE ?? defaultWorkerCompatibilityDate,
  };
}

export function createReleasePlan(options) {
  const profile = releaseProfiles[options.profileName];
  if (!profile) {
    throw new Error(`Unknown release profile: ${options.profileName}`);
  }

  return createSharedReleasePlan({
    appDir,
    options,
    profile,
    resolveHtreeCommand,
    wranglerVersion,
  });
}

export async function runRelease(options, runner = defaultRunner, hooks = {}) {
  const plan = createReleasePlan(options);
  return runReleasePlan(options, plan, runner, hooks);
}

export async function runAllReleases(options, runner = defaultRunner, hooks = {}) {
  const profiles = releaseProfileNames.map((profileName) =>
    parseArgs(
      [
        profileName,
        ...(options.branch ? ['--branch', options.branch] : []),
        ...(options.pagesOnly ? ['--pages-only'] : []),
        ...(options.skipCloudflare ? ['--skip-cloudflare'] : []),
        ...(options.dryRun ? ['--dry-run'] : []),
        ...(options.workerCompatibilityDate
          ? ['--compatibility-date', options.workerCompatibilityDate]
          : []),
      ],
      process.env,
    ),
  );

  const results = [];
  for (const profile of profiles) {
    results.push(await runRelease(profile, runner, hooks));
  }

  return {
    ...(options.dryRun ? { dryRun: true } : {}),
    profiles: results,
  };
}

export function usage() {
  return `Usage: node ./scripts/release-site.mjs <drive|files|all> [options]

Build once, test the built output, then publish to hashtree and deploy that same
directory to Cloudflare Workers Static Assets or Cloudflare Pages in parallel.

Options:
  --worker-name <name>    Cloudflare Worker service name for static assets
  --pages-project <name>  Cloudflare Pages project name
  --tree <name>           hashtree mutable tree name override
  --route <pattern>       Worker route, for example drive.iris.to/*
  --domain <hostname>     Worker custom domain, for example drive.iris.to
  --branch <name>         Pages branch/preview deployment target
  --pages-only            disable the built-in/default Worker target and use Pages
  --compatibility-date    Worker compatibility date override
  --skip-cloudflare       publish to hashtree only
  --skip-pages            alias for --skip-cloudflare
  --dry-run               print planned steps without running them

Environment:
  ${releaseProfiles.drive.workerNameEnv}   Default Worker name for the drive profile
  ${releaseProfiles.drive.pagesProjectEnv}   Default Pages project for the drive profile
  ${releaseProfiles.files.workerNameEnv}   Default Worker name for the legacy files profile
  ${releaseProfiles.files.pagesProjectEnv}   Default Pages project for the legacy files profile
  CF_WORKER_COMPATIBILITY_DATE   Default compatibility date for Worker deployments
`;
}

function printSummary(result) {
  const { profile, treeName, publish, pagesProject, pagesUrl, workerName, routes, domains } = result;
  console.log(`\n${profile.appName} release complete.`);
  console.log(`Hashtree immutable URL: htree://${publish.nhash}/index.html`);
  console.log(`Hashtree mutable URL: htree://${publish.publishedRef}`);
  console.log(`Hashtree owner URL: htree://${publish.publishedRef}`);
  if (workerName) {
    console.log(`Worker service: ${workerName}`);
  }
  for (const route of routes ?? []) {
    console.log(`Worker route: ${route}`);
  }
  for (const domain of domains ?? []) {
    console.log(`Worker custom domain: ${domain}`);
  }
  if (pagesProject) {
    console.log(`Pages project: ${pagesProject}`);
  }
  if (pagesUrl) {
    console.log(`Pages deployment: ${pagesUrl}`);
  }
  console.log(`Tree name: ${treeName}`);
}

function printAllSummaries(results) {
  for (const result of results.profiles) {
    printSummary(result);
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

if (isMainModule()) {
  const main = async () => {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      process.exit(0);
    }

    const result =
      parsed.profileName === 'all' ? await runAllReleases(parsed) : await runRelease(parsed);
    if (result.dryRun) {
      console.log(usage());
      if (parsed.profileName === 'all') {
        for (const profileResult of result.profiles) {
          console.log(`\n[${profileResult.profile.name}]`);
          for (const step of profileResult.steps) {
            console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`);
          }
        }
      } else {
        for (const step of result.steps) {
          console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`);
        }
      }
      process.exit(0);
    }
    if (parsed.profileName === 'all') {
      printAllSummaries(result);
    } else {
      printSummary(result);
    }
  };

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
