/**
 * Isolated-process workflow entry. The first stdin JSON line carries the run
 * initialization; later lines carry host protocol messages, while stdout is
 * reserved for process-to-host protocol messages.
 * @module @deepseek-ai/dsh-workflow-worker-thread/process-worker
 */

import { createInterface } from 'node:readline'
import { runWorkerSession } from './session.ts'
import type { WorkflowSessionPort } from './session.ts'
import type { HostToWorkerMessage } from './protocol.ts'
import type { WorkerInit } from './types.ts'

class StdioSessionPort implements WorkflowSessionPort {
  private listener: ((message: HostToWorkerMessage) => void) | undefined
  private readonly queued: HostToWorkerMessage[] = []

  on(_event: 'message', listener: (message: HostToWorkerMessage) => void): void {
    this.listener = listener
    for (const message of this.queued.splice(0)) listener(message)
  }

  receive(message: HostToWorkerMessage): void {
    if (this.listener === undefined) this.queued.push(message)
    else this.listener(message)
  }

  postMessage(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const port = new StdioSessionPort()
let initialized = false

input.on('line', (line) => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    process.exitCode = 1
    input.close()
    return
  }
  if (!initialized) {
    if (typeof value !== 'object' || value === null || !('init' in value) || value.init === undefined) {
      process.exitCode = 1
      input.close()
      return
    }
    initialized = true
    void runWorkerSession(port, value.init as WorkerInit).finally(() => { input.close() })
    return
  }
  port.receive(value as HostToWorkerMessage)
})

input.on('close', () => {
  if (!initialized) process.exitCode = 1
})
