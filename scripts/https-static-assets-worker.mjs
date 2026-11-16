import { directPathIsRoutable } from '../src/lib/driveEntryPath.js';

function forwardedScheme(request) {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) return forwardedProto.toLowerCase();

  const visitor = request.headers.get('cf-visitor');
  if (!visitor) return '';
  try {
    const parsed = JSON.parse(visitor);
    return typeof parsed.scheme === 'string' ? parsed.scheme.toLowerCase() : '';
  } catch {
    return '';
  }
}

function shouldRedirectToHttps(request, url) {
  const scheme = forwardedScheme(request);
  if (request.cf && !request.cf.tlsVersion) {
    return true;
  }
  return scheme === 'http' || (!scheme && url.protocol === 'http:');
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (shouldRedirectToHttps(request, url)) {
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url.toString(), 308);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && directPathIsRoutable(url.pathname)) {
      // The portable shell loads its assets relative to the root document.
      const location = new URL('/', url);
      location.hash = url.pathname + url.search;
      return new Response(null, {
        status: 302,
        headers: { Location: location.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
