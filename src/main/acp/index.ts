// Entry point for the app: one call wires the runtime host to the socket server.
import path from 'node:path';
import type { Runtime } from '../runtime/runtime';
import { AcpServer } from './server';
import { RuntimeAcpHost, type RuntimeHostOptions } from './runtimeHost';
import type { AcpClientInfo } from './agent';

export type { AcpClientInfo } from './agent';
export { ACP_MODES, RuntimeAcpHost } from './runtimeHost';
export { AcpServer } from './server';

export interface AcpServiceOptions extends RuntimeHostOptions {
  /** Default `<dataDir>/acp.sock`. */
  socketPath?: string;
  confirmClient: (info: AcpClientInfo) => Promise<boolean>;
}

export interface AcpService {
  readonly host: RuntimeAcpHost;
  readonly server: AcpServer;
  readonly socketPath: string;
  /** Follow the opt-in setting (idempotent, serialized). Rejects when the socket cannot be opened. */
  setEnabled(on: boolean): Promise<void>;
  /** Stop listening and flush the ACP session index (call on app quit). */
  dispose(): Promise<void>;
}

/**
 * Zed `settings.json` fragment that launches the bridge with Edict's own binary in Node mode.
 * `appExecutable` = process.execPath of the packaged app; `bridgeScript` = <resources>/app/acp-bridge.js.
 */
export function zedAgentServerConfig(o: { appExecutable: string; bridgeScript: string; socketPath?: string; name?: string }) {
  return {
    agent_servers: {
      [o.name ?? 'Edict']: {
        type: 'custom',
        command: o.appExecutable,
        args: [o.bridgeScript, ...(o.socketPath ? ['--socket', o.socketPath] : [])],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
}

export function createAcpService(rt: Runtime, opts: AcpServiceOptions): AcpService {
  const host = new RuntimeAcpHost(rt, opts);
  const socketPath = opts.socketPath ?? path.join(rt.opts.dataDir, 'acp.sock');
  const server = new AcpServer({ socketPath, host, confirmClient: opts.confirmClient, log: opts.log });
  return {
    host,
    server,
    socketPath,
    setEnabled: (on) => server.setEnabled(on),
    dispose: async () => {
      await server.setEnabled(false).catch(() => {});
      host.dispose();
    },
  };
}
