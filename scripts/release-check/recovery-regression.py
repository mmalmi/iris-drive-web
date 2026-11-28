"""Retain a red/green proof without changing the final candidate binding."""
import json
import pathlib
import subprocess

OUT = pathlib.Path('work/release-check/evidence').resolve()
source = pathlib.Path('src/lib/relayHolds.ts')
candidate = source.read_bytes()
baseline = '8992621cd398d68fc9a51267d775fc419fedd360'
results = []
try:
    for label in ('red', 'green'):
        source.write_bytes(subprocess.check_output(['git', 'show', baseline + ':' + str(source)])
                           if label == 'red' else candidate)
        with (OUT / ('recovery-' + label + '.log')).open('wb') as log:
            status = subprocess.run(['pnpm', 'exec', 'vitest', 'run', 'tests/relayHolds.test.ts',
                                     '--maxWorkers=1', '--reporter=json',
                                     '--outputFile=' + str(OUT / ('recovery-' + label + '.json'))],
                                    stdout=log, stderr=subprocess.STDOUT).returncode
        report = json.loads((OUT / ('recovery-' + label + '.json')).read_text())
        results.append({'label': label, 'exit': status, 'passed': report['numPassedTests'], 'failed': report['numFailedTests']})
        assert (status != 0 and report['numFailedTests'] >= 1) if label == 'red' else (status == 0 and report['numPassedTests'] == 4)
finally:
    source.write_bytes(candidate)
    (OUT / 'recovery-regression.json').write_text(json.dumps(results, indent=2) + '\n')
