import type { QRCodeToDataURLOptions } from 'qrcode';

/** A QR code image for `text`. The generator loads when the first code is needed. */
export async function qrCodeDataUrl(text: string, options?: QRCodeToDataURLOptions): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toDataURL(text, options);
}
