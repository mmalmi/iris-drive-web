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

    return env.ASSETS.fetch(request);
  },
};
