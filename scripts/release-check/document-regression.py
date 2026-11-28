"""Prove the superseded-root and cross-tab publication races before/after."""
import json
import pathlib
import subprocess

OUT = pathlib.Path('work/release-check/evidence').resolve()
paths = [pathlib.Path(p) for p in ('src/drive/profileDriveRootPublish.ts', 'src/lib/driveRootTabs.ts', 'src/treeRootCache.ts')]
candidate = {p: p.read_bytes() for p in paths}
results = []
try:
    for label in ('red', 'guard-red', 'green'):
        for p in paths:
            baseline = 'faca5c8c8181cdcd164f665ffcc8997149e769c8' if label == 'guard-red' else '3e31943128c9c09ee923a9466e4514e31b47e0ba'
            p.write_bytes(candidate[p] if label == 'green' else subprocess.check_output(['git', 'show', baseline + ':' + str(p)]))
        with (OUT / ('documents-' + label + '.log')).open('wb') as log:
            status = subprocess.run(['pnpm', 'exec', 'vitest', 'run', 'tests/profileDriveRootPublish.test.ts', 'tests/driveRootTabs.test.ts',
                                     '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(OUT / ('documents-' + label + '.json'))],
                                    stdout=log, stderr=subprocess.STDOUT).returncode
        report = json.loads((OUT / ('documents-' + label + '.json')).read_text())
        results.append({'label': label, 'exit': status, 'passed': report['numPassedTests'], 'failed': report['numFailedTests']})
        assert (status == 0 and report['numFailedTests'] == 0) if label == 'green' else (status != 0 and report['numFailedTests'] >= (3 if label == 'red' else 1))
finally:
    for p, data in candidate.items():
        p.write_bytes(data)
    (OUT / 'documents-regression.json').write_text(json.dumps(results, indent=2) + '\n')
