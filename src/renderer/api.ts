// Renderer → main bridge (typed loosely; the main process whitelists every method).
declare global {
  interface Window {
    edict: {
      invoke: (method: string, ...args: unknown[]) => Promise<any>;
      onEvent: (fn: (e: any) => void) => () => void;
      onTerm: (fn: (e: { id: string; kind: string; payload: string }) => void) => () => void;
      platform: string;
    };
    monaco: any;
    Phaser: any;
    require: any;
    define: any;
    MonacoEnvironment: any;
  }
}

export async function call<T = any>(method: string, ...args: unknown[]): Promise<T> {
  try {
    return await window.edict.invoke(method, ...args);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'rt:invoke': (Error: )?/, '');
    throw new Error(msg);
  }
}

export const isMac = () => window.edict?.platform === 'darwin';
