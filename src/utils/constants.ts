const TEST_BOOTSTRAP_PUBKEY = import.meta.env.VITE_TEST_BOOTSTRAP_PUBKEY as string | undefined;
// Default content/social graph bootstrap pubkey (sirius)
export const DEFAULT_BOOTSTRAP_PUBKEY =
  import.meta.env.VITE_TEST_MODE && TEST_BOOTSTRAP_PUBKEY
    ? TEST_BOOTSTRAP_PUBKEY
    : '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0';
