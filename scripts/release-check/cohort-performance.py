"""Alternate matched main-flow samples on baseline and corrected dependencies.

These are source-level private/shared batch and large-file ZIP measurements,
not browser-network timing. Both sides use the same bounded hosted machine.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time

BASE = '8992621cd398d68fc9a51267d775fc419fedd360'
OUT = pathlib.Path('work/release-check/evidence').resolve()
FILES = ['package.json', 'pnpm-lock.yaml', 'src/lib/relayHolds.ts',
         'src/components/settings/RecoveryPhraseSettings.svelte']
candidate = {name: pathlib.Path(name).read_bytes() for name in FILES}
baseline = {name: subprocess.check_output(['git', 'show', BASE + ':' + name]) for name in FILES}
sha = lambda value: hashlib.sha256(value).hexdigest()
result = {'baseline': BASE, 'candidate': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
          'baselineFiles': {n: sha(v) for n, v in baseline.items()},
          'candidateFiles': {n: sha(v) for n, v in candidate.items()}, 'steps': []}

def run(label, command):
    assert shutil.disk_usage('.').free > 5 * 1024**3
    start = time.monotonic()
    with (OUT / (label + '.log')).open('wb') as log:
        status = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT).returncode
    step = {'name': label, 'exit': status, 'seconds': round(time.monotonic() - start, 3)}
    result['steps'].append(step)
    print(json.dumps(step), flush=True)
    (OUT / 'cohort-performance.json').write_text(json.dumps(result, indent=2) + '\n')
    assert status == 0, label

try:
    for sample in range(3):
        for label in (['baseline', 'candidate'] if sample % 2 == 0 else ['candidate', 'baseline']):
            files = baseline if label == 'baseline' else candidate
            for name, data in files.items():
                pathlib.Path(name).write_bytes(data)
            run(f'{label}-install-{sample}', ['pnpm', 'install', '--frozen-lockfile',
                                            '--store-dir', os.environ['DRIVE_CHECK_TOOLS'] + '/store'])
            assert all(pathlib.Path(n).read_bytes() == data for n, data in files.items())
            os.environ['DRIVE_FLOW_METRICS'] = str(OUT / (label + '-flows.jsonl'))
            run(f'{label}-flows-{sample}', ['pnpm', 'exec', 'vitest', 'run',
                                           'tests/reviewFlows.bench.test.ts', '--maxWorkers=1'])
finally:
    for name, data in candidate.items():
        pathlib.Path(name).write_bytes(data)
    result['candidateRestored'] = all(pathlib.Path(n).read_bytes() == data for n, data in candidate.items())
    (OUT / 'cohort-performance.json').write_text(json.dumps(result, indent=2) + '\n')
