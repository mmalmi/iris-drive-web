export function isPortableBaseUrl(baseUrl: string | undefined): boolean {
  return baseUrl === './';
}

export function isPortableBuild(): boolean {
  return isPortableBaseUrl(import.meta.env.BASE_URL);
}
