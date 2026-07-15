/// <reference types="vite/client" />

declare module 'virtual:pwa-register' {
  export function registerSW(options?: {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegisteredSW?: (swUrl: string, registration?: ServiceWorkerRegistration) => void;
    onRegisterError?: (error: unknown) => void;
  }): (reloadPage?: boolean) => Promise<void>;
}

declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

declare module '*.svelte' {
  import type { ComponentType } from 'svelte';
  const component: ComponentType;
  export default component;
  export const open: (...args: any[]) => any;
}

declare module 'debug' {
  export type Debugger = ((formatter: unknown, ...args: unknown[]) => void) & {
    enabled: boolean;
    namespace: string;
    color: string;
    diff: number;
    log: (...args: unknown[]) => void;
    destroy: () => boolean;
    extend(namespace: string): Debugger;
  };
  const debug: (namespace: string) => Debugger;
  export default debug;
}
