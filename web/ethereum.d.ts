export {};

declare global {
  interface Window {
    ethereum?: {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
    };
  }
}
