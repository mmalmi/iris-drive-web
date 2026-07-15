export interface ShareDialogRequest {
  source_path: string;
  display_name: string;
  app_url: string;
  web_path: string;
}

export interface ShareDialogRecipientHint {
  representative_npub: string;
  display_name?: string;
  nostr_identity_id?: string;
}

export function parseShareDialogPath(input: string): ShareDialogRequest | null {
  const query = shareDialogQuery(input.trim());
  if (query === null) return null;
  const params = new URLSearchParams(query);
  const sourcePath = (params.get('path') ?? '').trim();
  if (!sourcePath) return null;
  const displayName = (params.get('name') ?? params.get('display_name') ?? '').trim();
  return buildShareDialogRequest(sourcePath, displayName);
}

export function buildShareDialogRequest(
  sourcePath: string,
  displayName = '',
): ShareDialogRequest | null {
  const trimmedPath = sourcePath.trim();
  if (!trimmedPath) return null;
  const trimmedName = displayName.trim();
  const params = new URLSearchParams();
  params.set('path', trimmedPath);
  if (trimmedName) {
    params.set('name', trimmedName);
  }
  const query = params.toString();
  return {
    source_path: trimmedPath,
    display_name: trimmedName,
    app_url: `iris-drive://share?${query}`,
    web_path: `/share?${query}`,
  };
}

export function shareDialogRequestWithRecipientHint(
  request: ShareDialogRequest,
  recipient: ShareDialogRecipientHint | null,
): ShareDialogRequest {
  if (!recipient) return request;
  return {
    ...request,
    app_url: shareDialogUrlWithRecipientHint(request.app_url, recipient),
    web_path: shareDialogUrlWithRecipientHint(request.web_path, recipient),
  };
}

function shareDialogUrlWithRecipientHint(
  url: string,
  recipient: ShareDialogRecipientHint,
): string {
  const [base, query = ''] = url.split('?', 2);
  const params = new URLSearchParams(query);
  params.set('recipient_npub', recipient.representative_npub);
  const name = recipient.display_name?.trim();
  if (name) {
    params.set('recipient_name', name);
  }
  const profileId = recipient.nostr_identity_id?.trim();
  if (profileId) {
    params.set('recipient_profile', profileId);
  }
  return `${base}?${params.toString()}`;
}

function shareDialogQuery(input: string): string | null {
  const withoutHash = input.startsWith('#') ? input.slice(1) : input;
  if (withoutHash.startsWith('?')) return withoutHash.slice(1);
  if (withoutHash === '/share') return '';
  if (withoutHash.startsWith('/share?')) return withoutHash.slice('/share?'.length);
  if (withoutHash.startsWith('https://drive.iris.to/share?')) {
    return withoutHash.slice('https://drive.iris.to/share?'.length);
  }
  if (withoutHash.startsWith('iris-drive://share?')) {
    return withoutHash.slice('iris-drive://share?'.length);
  }
  if (withoutHash.startsWith('iris-drive:/share?')) {
    return withoutHash.slice('iris-drive:/share?'.length);
  }
  return null;
}
