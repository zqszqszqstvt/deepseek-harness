/**
 * Message peer used by the workflow host lifecycle. A peer may be a Node
 * worker thread or an isolated child process; both expose the same ordered
 * message, failure, exit, and termination operations.
 * @module @deepseek-ai/dsh-workflow-worker-thread/peer
 */

import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { WorkerToHostMessage } from './protocol.ts'
import type { WorkerInit } from './types.ts'

/** The transport operations consumed by one workflow run's host controller. */
export interface WorkflowPeer {
  /** Whether inbound messages come from a peer that may run escaped model code. */
  readonly trustedMessages: boolean
  /** Register an inbound-message listener. */
  on(event: 'message', listener: (message: WorkerToHostMessage) => void): this
  /** Register a transport-failure listener. */
  on(event: 'error' | 'messageerror', listener: (error: unknown) => void): this
  /** Register the physical-exit listener. */
  on(event: 'exit', listener: (code: number) => void): this
  /** Send one host protocol message. */
  postMessage(message: unknown): void
  /** Force the peer to exit and resolve after it is gone. */
  terminate(): Promise<number>
}

/** Factory selected by the engine before it creates the shared host lifecycle controller. */
export type WorkflowPeerFactory = (init: WorkerInit) => WorkflowPeer

/**
 * The scrubbed worker environment: no ambient credentials or loader flags.
 * Windows requires its host temp path for loader caches; source mode may also
 * carry the repository's explicit tsconfig pin.
 * @param platform - host platform; overridable for cross-platform tests.
 * @param tsconfigPath - source loader tsconfig pin when present.
 * @returns the worker environment.
 */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const tmp = tmpdir()
    env.TMP = tmp
    env.TEMP = tmp
  }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

/** Resolve the built worker bundle or the source bootstrap used by tests and source launches. */
function resolveWorkerSpawn(init: WorkerInit): { entry: string | URL; options: WorkerOptions } {
  /* v8 ignore next 3 -- built output is exercised by built-worker.e2e.ts. */
  if (!import.meta.url.endsWith('.ts')) {
    return { entry: fileURLToPath(new URL('./worker.cjs', import.meta.url)), options: { workerData: init, env: workerSpawnEnv(), execArgv: [] } }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
      execArgv: [],
    },
  }
}

/** Wrap a real Node Worker with the trust marker required by {@link WorkflowPeer}. */
class ThreadWorkflowPeer extends Worker implements WorkflowPeer {
  readonly trustedMessages = true
}

/**
 * Create the original worker-thread execution peer.
 * @param init - validated workflow initialization data.
 * @returns a fresh worker peer.
 */
export const createThreadPeer: WorkflowPeerFactory = (init) => {
  const { entry, options } = resolveWorkerSpawn(init)
  return new ThreadWorkflowPeer(entry, options)
}
