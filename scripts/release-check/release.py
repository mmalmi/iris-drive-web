"""Complete product gates on one exact source/dependency/artifact candidate.

Runs in the pinned Playwright image with 2 CPUs, 3 GiB and no swap. There are
no source substitutions, signing credentials, publication or native builds.
"""
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import tarfile
import time

OUT = pathlib.Path('work/release-check/evidence').resolve()
TOOLS = pathlib.Path(os.environ['DRIVE_CHECK_TOOLS'])
OUT.mkdir(parents=True, exist_ok=True)
os.environ.update(PW_WORKERS='1', PW_APP_PORT='15373',
                  PW_TEST_BLOSSOM_URL='http://127.0.0.1:18781', HTREE_ADDR='127.0.0.1:18781',
                  HTREE_CONFIG_DIR=str(TOOLS / 'tmp/blossom-config'), HTREE_DATA_DIR=str(TOOLS / 'tmp/blossom-data'),
                  HTREE_BIN=str(TOOLS / 'bin/htree'), IRIS_DRIVE_BIN=str(TOOLS / 'bin/idrive'),
                  IRIS_DRIVE_BIN_SHA256='a25406357bd0b9c46c37b87de050d5e89aaf7cac167d41b570c49d8e6e0d95f5')
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
tracked = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')[:-1]
source = {name: sha(pathlib.Path(name)) for name in tracked}
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
receipt = {'revision': revision, 'sourceFiles': source, 'steps': [],
           'browserImage': 'mcr.microsoft.com/playwright@sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0',
           'cpus': 2, 'memoryBytes': 3 * 1024**3, 'swapBytes': 0, 'browserWorkers': 1}
(OUT / 'source-manifest.json').write_text(json.dumps(source, indent=2) + '\n')
with (OUT / 'source.tar.gz').open('wb') as archive:
    subprocess.run(['git', 'archive', '--format=tar.gz', revision], stdout=archive, check=True)
receipt['sourceArchiveSHA256'] = sha(OUT / 'source.tar.gz')
receipt['sourceManifestSHA256'] = sha(OUT / 'source-manifest.json')
(OUT / 'runtime-system-packages.txt').write_bytes(subprocess.check_output(['dpkg-query', '-W']))
dist_manifest = None

def run(label, command):
    assert shutil.disk_usage('.').free > 5 * 1024**3, 'Hosted disk reserve reached'
    start = time.monotonic()
    print('START ' + label, flush=True)
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    check = {'name': label, 'command': command, 'exit': result.returncode,
             'seconds': round(time.monotonic() - start, 3)}
    receipt['steps'].append(check)
    receipt['sourceUnchanged'] = all(sha(pathlib.Path(name)) == value for name, value in source.items())
    if dist_manifest:
        receipt['distUnchanged'] = all(sha(pathlib.Path('dist') / f['path']) == f['sha256'] for f in dist_manifest)
    if label in ('browser', 'recovery', 'fips', 'native', 'peer'):
        artifacts = pathlib.Path('test-results')
        if artifacts.exists():
            shutil.copytree(artifacts, OUT / (label + '-artifacts'), dirs_exist_ok=True)
    (OUT / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(check), flush=True)
    assert result.returncode == 0, label + ' failed; retain complete log'
    assert receipt['sourceUnchanged'], 'Source changed during qualification'
    assert receipt.get('distUnchanged', True), 'Artifact changed during qualification'
    return (OUT / (label + '.log')).read_text()

run('native-tools', ['python3', 'scripts/release-check/linux-tools.py'])
run('install', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', str(TOOLS / 'store')])
run('installed-archives', ['python3', 'scripts/release-check/verify-install.py'])
run('recovery-regression', ['python3', 'scripts/release-check/recovery-regression.py'])
run('documents-regression', ['python3', 'scripts/release-check/document-regression.py'])
run('verify-htree', ['node', 'scripts/verify-htree-cli.mjs'])
run('lint', ['pnpm', 'run', 'lint'])
run('check', ['pnpm', 'run', 'check'])
run('unit', ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2', '--reporter=json', '--outputFile=' + str(OUT / 'unit.json')])
run('build', ['pnpm', 'run', 'build'])
dist_manifest = [{'path': str(p.relative_to('dist')), 'sha256': sha(p), 'bytes': p.stat().st_size}
                 for p in sorted(pathlib.Path('dist').rglob('*')) if p.is_file()]
(OUT / 'dist-manifest.json').write_text(json.dumps(dist_manifest, indent=2) + '\n')
receipt['distManifestSHA256'] = sha(OUT / 'dist-manifest.json')
with tarfile.open(OUT / 'dist.tar.gz', 'w:gz') as archive:
    for entry in sorted(pathlib.Path('dist').iterdir()):
        archive.add(entry, arcname=entry.name)
receipt['distArchiveSHA256'] = sha(OUT / 'dist.tar.gz')
run('portable', ['node', 'scripts/smoke-files-iris-portable.mjs'])
run('graph', ['node', 'scripts/check-graph-bootstrap-browser.mjs', '--evidence', str(OUT / 'graph.json')])
run('recovery', ['pnpm', 'exec', 'playwright', 'test', 'e2e/recovery-phrase.spec.ts', '--project=chromium', '--retries=0'])
if os.environ.get('DRIVE_CHECK_SCOPE') == 'documents':
    run('browser', ['pnpm', 'exec', 'playwright', 'test', 'e2e/documents-tabs.spec.ts', '--project=chromium', '--retries=0'])
    raise SystemExit(0)
manifest = json.loads(pathlib.Path('package.json').read_text())
browser = shlex.split(manifest['scripts']['test:e2e:release:local'].split('playwright test ', 1)[1].split(' && ')[0])
# The exact recovery cases already ran above, including the pending-upload race.
browser.remove('e2e/recovery-phrase.spec.ts')
run('browser', ['pnpm', 'exec', 'playwright', 'test', *browser])
run('peer', ['pnpm', 'exec', 'playwright', 'test', '-c', 'e2e/peer-announcements.config.ts'])
run('fips', ['pnpm', 'run', 'test:e2e:fips'])
native = run('native', ['pnpm', 'run', 'test:e2e:native-release'])
assert re.search(r'\b11 passed\b', native) and not re.search(r'\b[1-9]\d* (?:failed|skipped)\b', native)
receipt['completeProjectGatesPassed'] = True
(OUT / 'release.json').write_text(json.dumps(receipt, indent=2) + '\n')
