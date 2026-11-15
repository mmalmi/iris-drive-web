// Entry points shared by the hosted worker, the router and the search field.
/** @param {string} pathname */
export function directPathIsRoutable(pathname) {
  return pathname === '/share' || /^\/(approve-device|share-invite|share-join)\/[A-Za-z0-9_-]+$/.test(pathname);
}
