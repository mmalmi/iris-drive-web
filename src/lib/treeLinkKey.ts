// Link secrets are opaque random bytes. Both legacy and versioned trees can be shared.
export function isTreeLinkKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{2}){32,33}$/i.test(value);
}
