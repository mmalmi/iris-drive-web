"""Resolve the corrected dependency cohort on the pinned hosted toolchain.

This prepares a reviewable lockfile. It does not qualify or publish the app.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

OUT = pathlib.Path('work/release-check/evidence')
assert shutil.disk_usage('.').free > 5 * 1024**3
before = pathlib.Path('pnpm-lock.yaml').read_bytes()
with (OUT / 'lock.log').open('wb') as log:
    result = subprocess.run(['pnpm', 'install', '--lockfile-only', '--ignore-scripts',
                             '--store-dir', os.environ['DRIVE_CHECK_TOOLS'] + '/store'],
                            stdout=log, stderr=subprocess.STDOUT)
after = pathlib.Path('pnpm-lock.yaml').read_bytes()
shutil.copyfile('pnpm-lock.yaml', OUT / 'pnpm-lock.yaml')
(OUT / 'lock.json').write_text(json.dumps({
    'candidate': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'exit': result.returncode,
    'beforeSHA256': hashlib.sha256(before).hexdigest(),
    'afterSHA256': hashlib.sha256(after).hexdigest(),
}, indent=2) + '\n')
raise SystemExit(result.returncode)
