"""Reuse reviewed public binaries; this never builds or publishes native code."""
import hashlib
import json
import os
import pathlib
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(os.environ['DRIVE_CHECK_TOOLS'])
OUT = pathlib.Path('work/release-check/evidence')
TOOLS = {
    'htree': {
        'source': 'bf132d40a71f28a171a1eab3defa2c874539bf1b',
        'url': 'https://github.com/mmalmi/hashtree/releases/download/v0.2.142/hashtree-x86_64-unknown-linux-musl.tar.gz',
        'archiveSHA256': '2336992365786de9c017c1ded3a0cb3a52f80b4c000878e4e3b807642e809b4a',
        'executableSHA256': 'a7ec2b2dce1c918865eb276e0258af176ec5a6240cab2babdbba343db89dcd17',
        'version': 'htree 0.2.142',
    },
    'idrive': {
        'source': 'ce556f47b535caf993796d5ce11ff2885e41c754',
        'url': 'https://cdn.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Firis-drive/v0.1.52/assets/idrive-v0.1.52-x86_64-unknown-linux-gnu.tar.gz',
        'archiveSHA256': '693c98fd1feffa96704348f141df9a67e1a0e0c63e94b6af33851d60c1937808',
        'executableSHA256': 'a25406357bd0b9c46c37b87de050d5e89aaf7cac167d41b570c49d8e6e0d95f5',
        'version': 'idrive 0.1.52',
    },
}
for name, pin in TOOLS.items():
    archive = ROOT / (name + '.tar.gz')
    with urllib.request.urlopen(pin['url'], timeout=120) as response:
        archive.write_bytes(response.read())
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == pin['archiveSHA256'], name
    with tarfile.open(archive) as tar:
        members = [m for m in tar.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name == name]
        assert len(members) == 1, name
        data = tar.extractfile(members[0]).read()
    assert hashlib.sha256(data).hexdigest() == pin['executableSHA256'], name
    target = ROOT / 'bin' / name
    target.write_bytes(data)
    target.chmod(0o755)
    assert subprocess.check_output([str(target), '--version'], text=True).strip() == pin['version']
(OUT / 'native-tools.json').write_text(json.dumps(TOOLS, indent=2) + '\n')
