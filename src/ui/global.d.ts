import type { NurseDeckBridge } from '@shared/ipc.js';

declare global {
  interface Window {
    nursedeck: NurseDeckBridge;
  }
}
