const DRIVE_HOST = 'drive.iris.to';

export default {
  fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = DRIVE_HOST;
    url.port = '';

    return Response.redirect(url.toString(), 308);
  },
};
