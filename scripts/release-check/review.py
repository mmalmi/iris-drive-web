"""Prove review regressions and fixes on the accepted dependency line.

This lane does not qualify the pending runtime cohort or publish an artifact.
All source substitutions are restored before the final source binding check.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time

BASE = 'f191d8928ce13674562a386283decdcc575ca06f'
OUT = pathlib.Path('work/release-check/evidence')
FIXES = ['src/actions/entry.ts', 'src/actions/file.ts', 'src/stores/upload.ts',
         'src/drive/profileDriveMutation.ts', 'src/drive/profileDriveRouteEntry.ts']
TESTS = ['tests/profileDriveAsyncWrites.test.ts', 'tests/profileDriveRouteEntry.test.ts',
         'tests/trashActions.test.ts', 'tests/sharedBatchWrites.test.ts', 'tests/profileDriveUiActions.test.ts']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def run(label, command):
    assert shutil.disk_usage('.').free > 5 * 1024**3, 'Hosted disk reserve reached'
    started = time.monotonic()
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    record = {'name': label, 'command': command, 'exit': result.returncode,
              'seconds': round(time.monotonic() - started, 3)}
    receipt['steps'].append(record)
    (OUT / 'review.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    return result.returncode

files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')[:-1]
original = {name: pathlib.Path(name).read_bytes() for name in files}
receipt = {'candidate': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
           'dependencyRevision': BASE, 'steps': [],
           'sourceFiles': {name: sha(data) for name, data in original.items()}}
try:
    for name in ['package.json', 'pnpm-lock.yaml']:
        pathlib.Path(name).write_bytes(subprocess.check_output(['git', 'show', BASE + ':' + name]))
    receipt['installedManifestSHA256'] = sha(pathlib.Path('package.json').read_bytes())
    receipt['installedLockSHA256'] = sha(pathlib.Path('pnpm-lock.yaml').read_bytes())
    assert run('install', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', os.environ['DRIVE_CHECK_TOOLS'] + '/store']) == 0
    for name in FIXES:
        pathlib.Path(name).write_bytes(subprocess.check_output(['git', 'show', BASE + ':' + name]))
    red = run('red', ['pnpm', 'exec', 'vitest', 'run', *TESTS, '--maxWorkers=2', '--reporter=json', '--outputFile=' + str(OUT / 'red.json')])
    red_report = json.loads((OUT / 'red.json').read_text())
    assert red != 0 and red_report['numFailedTests'] >= 9, 'Regression proof must fail the new behavior assertions'
    for name in FIXES:
        pathlib.Path(name).write_bytes(original[name])
    assert run('green', ['pnpm', 'exec', 'vitest', 'run', *TESTS, '--maxWorkers=2', '--reporter=json', '--outputFile=' + str(OUT / 'green.json')]) == 0
    assert run('lint', ['pnpm', 'run', 'lint']) == 0
    assert run('check', ['pnpm', 'run', 'check']) == 0
    assert run('unit', ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2', '--reporter=json', '--outputFile=' + str(OUT / 'unit.json')]) == 0
    assert sha(pathlib.Path('pnpm-lock.yaml').read_bytes()) == receipt['installedLockSHA256']
finally:
    for name in ['package.json', 'pnpm-lock.yaml', *FIXES]:
        pathlib.Path(name).write_bytes(original[name])
    receipt['candidateSourceRestored'] = all(pathlib.Path(name).read_bytes() == data for name, data in original.items())
    (OUT / 'review.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert receipt['candidateSourceRestored']
