"""Bind each installed public tarball to the frozen reviewed archive bytes."""
import base64
import hashlib
import io
import json
import pathlib
import re
import tarfile
import urllib.request

OUT = pathlib.Path('work/release-check/evidence')
pins = json.loads(pathlib.Path('scripts/release-check/cohort-pins.json').read_text())['packages']
lock = pathlib.Path('pnpm-lock.yaml').read_text()
by_url = {p['url']: p for p in pins.values()}
records = []
pattern = r"^  (.+):\n    resolution: \{integrity: ([^,}]+), tarball: ([^}]+)\}"
for key, integrity, url in re.findall(pattern, lock, re.M):
    name = key.strip("'").split('@https:', 1)[0]
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    algorithm, expected = integrity.split('-', 1)
    assert base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == expected, name
    if url in by_url:
        assert integrity == by_url[url]['integrity'], name
        assert hashlib.sha256(data).hexdigest() == by_url[url]['sha256'], name
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        files = {}
        for member in tar.getmembers():
            if not member.isfile():
                continue
            relative = pathlib.PurePosixPath(member.name)
            assert relative.parts[0] == 'package' and '..' not in relative.parts
            files[str(relative.relative_to('package'))] = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
    installed = sorted(pathlib.Path('node_modules/.pnpm').glob('*/node_modules/' + name))
    assert installed, 'Missing installed package: ' + name
    copies = []
    for directory in installed:
        for filename, expected_sha in files.items():
            actual = directory / filename
            assert actual.is_file() and hashlib.sha256(actual.read_bytes()).hexdigest() == expected_sha, str(actual)
        copies.append(str(directory))
    records.append({'package': name, 'url': url, 'archiveSHA256': hashlib.sha256(data).hexdigest(),
                    'integrity': integrity, 'installedPaths': copies, 'files': files})
assert not re.search(r'fips-ts/releases/download/runtime-v0\.0\.(63|65|66)/', lock)
for name, pin in pins.items():
    for directory in pathlib.Path('node_modules/.pnpm').glob('*/node_modules/' + name):
        manifest = json.loads((directory / 'package.json').read_text())
        assert manifest['version'] == pin['version'], str(directory)
        assert any(record['package'] == name and record['url'] == pin['url'] for record in records), name
(OUT / 'installed-archives.json').write_text(json.dumps(records, indent=2) + '\n')
print(json.dumps({'archives': len(records), 'installedCopies': sum(len(r['installedPaths']) for r in records),
                  'files': sum(len(r['files']) * len(r['installedPaths']) for r in records)}))
