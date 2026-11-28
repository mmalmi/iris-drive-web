"""Prepare the previously qualified Linux toolchain without repository credentials."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(os.environ['RUNNER_TEMP']) / 'drive-tools'
OUT = pathlib.Path('work/release-check/evidence')
IMAGE = 'docker.io/library/node@sha256:40168539433ce47c04c4106f8ca42aee6f493cff42c08dede9e1f2ca0398b05b'
NODE_SHA = 'd931c649850ffa7155b8ceffb400dc916ef325866e509cc52ae36e33e8fbb9a9'
PNPM_SHA = 'a1cdd7b468386a9d78a081da05d6049d7e598db62a299db92df21a7062a4b183'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

assert shutil.disk_usage('.').free > 10 * 1024**3, 'Hosted runner needs 10 GiB free before setup'
ROOT.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
(ROOT / 'bin').mkdir(exist_ok=True)
(ROOT / 'tmp').mkdir(exist_ok=True)
subprocess.run(['docker', 'pull', IMAGE], check=True)
container = subprocess.check_output(['docker', 'create', IMAGE], text=True).strip()
try:
    subprocess.run(['docker', 'cp', container + ':/usr/local/bin/node', str(ROOT / 'bin/node')], check=True)
finally:
    subprocess.run(['docker', 'rm', container], check=True)
assert digest(ROOT / 'bin/node') == NODE_SHA
archive = ROOT / 'pnpm-10.23.0.tgz'
archive.write_bytes(urllib.request.urlopen('https://registry.npmjs.org/pnpm/-/pnpm-10.23.0.tgz', timeout=60).read())
assert digest(archive) == PNPM_SHA
with tarfile.open(archive) as tar:
    tar.extractall(ROOT / 'pnpm', filter='data')
(ROOT / 'bin/pnpm').symlink_to(ROOT / 'pnpm/package/bin/pnpm.cjs')
env = dict(os.environ, PATH=str(ROOT / 'bin') + ':' + os.environ['PATH'])
record = {
    'nodeImage': IMAGE, 'nodeSHA256': NODE_SHA, 'pnpmArchiveSHA256': PNPM_SHA,
    'node': subprocess.check_output(['node', '--version'], env=env, text=True).strip(),
    'pnpm': subprocess.check_output(['pnpm', '--version'], env=env, text=True).strip(),
    'os': pathlib.Path('/etc/os-release').read_text(),
    'architecture': subprocess.check_output(['uname', '-m'], text=True).strip(),
    'runnerImage': os.environ.get('ImageVersion'),
    'freeBytes': shutil.disk_usage('.').free,
    'limits': {'cpus': 2, 'memoryBytes': 3 * 1024**3, 'swapBytes': 0},
}
assert record['node'] == 'v26.13.1' and record['pnpm'] == '10.23.0'
(OUT / 'toolchain.json').write_text(json.dumps(record, indent=2) + '\n')
(OUT / 'system-packages.txt').write_bytes(subprocess.check_output(['dpkg-query', '-W']))

