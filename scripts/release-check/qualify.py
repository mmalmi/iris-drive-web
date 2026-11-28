"""Dispatch bounded, credential-free qualification of exact product inputs."""
import os
import runpy

scope = os.environ.get('DRIVE_CHECK_SCOPE', 'release')
if scope in ('review', 'performance'):
    runpy.run_path('scripts/release-check/review.py', run_name='__main__')
elif scope == 'lock':
    runpy.run_path('scripts/release-check/lock.py', run_name='__main__')
elif scope in ('release', 'documents', 'recovery', 'linking'):
    runpy.run_path('scripts/release-check/release.py', run_name='__main__')
elif scope == 'cohort-performance':
    runpy.run_path('scripts/release-check/cohort-performance.py', run_name='__main__')
else:
    raise ValueError(f'Unknown qualification scope: {scope}')
