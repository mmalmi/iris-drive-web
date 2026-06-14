export const BOOTSTRAP_SECKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';
export const FOLLOW_SECKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000002';
export const FOLLOW2_SECKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000003';

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (normalized.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const offset = i * 2;
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16);
    if (Number.isNaN(value)) throw new Error('Invalid hex value');
    out[i] = value;
  }
  return out;
}

export const BOOTSTRAP_SECKEY = hexToBytes(BOOTSTRAP_SECKEY_HEX);
export const FOLLOW_SECKEY = hexToBytes(FOLLOW_SECKEY_HEX);
export const FOLLOW2_SECKEY = hexToBytes(FOLLOW2_SECKEY_HEX);
