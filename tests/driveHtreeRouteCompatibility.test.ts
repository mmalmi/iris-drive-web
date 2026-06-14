// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseRouteFromHash } from '../src/stores/route';

const OWNER_NPUB = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

function driveRouteHashForHtreeRemote(remoteUrl: string): string {
  const raw = remoteUrl.trim();
  const withoutScheme = raw.startsWith('htree://') ? raw.slice('htree://'.length) : '';
  if (!withoutScheme) throw new Error(`Not an htree remote URL: ${remoteUrl}`);

  const [pathPart, fragment = ''] = withoutScheme.split('#', 2);
  const separatorIndex = pathPart.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === pathPart.length - 1) {
    throw new Error(`Missing htree owner or repo path: ${remoteUrl}`);
  }

  const owner = pathPart.slice(0, separatorIndex);
  const repoParts = pathPart.slice(separatorIndex + 1).split('/').filter(Boolean);
  const routeParts = [owner, ...repoParts]
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join('/');
  const keyQuery = fragment.startsWith('k=') ? `?${fragment}` : '';
  return `#/${routeParts}${keyQuery}`;
}

describe('drive htree route compatibility', () => {
  it('opens the same public repo path shape emitted by git-remote-htree', () => {
    const hash = driveRouteHashForHtreeRemote(`htree://${OWNER_NPUB}/public/git-remote-demo`);
    const driveUrl = new URL(hash, 'https://drive.iris.to/');

    expect(driveUrl.href).toBe(`https://drive.iris.to/#/${OWNER_NPUB}/public/git-remote-demo`);
    expect(parseRouteFromHash(driveUrl.hash)).toMatchObject({
      npub: OWNER_NPUB,
      treeName: 'public',
      path: ['git-remote-demo'],
      isPermalink: false,
    });
  });

  it('keeps link-visible htree clone keys on the drive route', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hash = driveRouteHashForHtreeRemote(`htree://${OWNER_NPUB}/secret-repo#k=${key}`);
    const route = parseRouteFromHash(hash);

    expect(hash).toBe(`#/${OWNER_NPUB}/secret-repo?k=${key}`);
    expect(route).toMatchObject({
      npub: OWNER_NPUB,
      treeName: 'secret-repo',
      path: [],
      isPermalink: false,
    });
    expect(route.params.get('k')).toBe(key);
  });
});
