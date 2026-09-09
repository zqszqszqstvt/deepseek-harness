import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '../src/index.ts'
import { sandboxedProcessArgv } from '../src/process-peer.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const builtIndex = join(packageRoot, 'lib', 'index.js')
const builtWorker = join(packageRoot, 'lib', 'worker.cjs')
const builtProcessWorker = join(packageRoot, 'lib', 'process-worker.cjs')
const run = promisify(execFile)

const PROCESS_INIT = {
  meta: { name: 'process-smoke', description: 'built process worker smoke' },
  body: 'return 6 * 7',
  limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 1_000 },
}
const PROCESS_INPUT = `${JSON.stringify({ init: PROCESS_INIT })}\n${JSON.stringify({ type: 'go' })}\n`

function runProcessWorker(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtProcessWorker], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => { resolve({ stdout, stderr, code }) })
    child.stdin.end(PROCESS_INPUT)
  })
}

const bwrapUsable = process.platform === 'linux' && existsSync(builtProcessWorker)
  && spawnSync('bwrap', sandboxedProcessArgv({ nodePath: process.execPath, workerPath: builtProcessWorker }), {
    input: PROCESS_INPUT,
    encoding: 'utf8',
    timeout: 10_000,
  }).status === 0

/** Plain Node must load the built index and its worker without tsx. */
describe.skipIf(!existsSync(builtIndex) || !existsSync(builtWorker))('built worker entry (lib/worker.cjs)', () => {
  it('the built engine spawns its built worker and completes a run', async () => {
    const driver = join(packageRoot, `.built-worker-driver-${process.pid}.mjs`)
    try {
      await writeFile(driver, `
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const ctx = new Context()
await ctx.plugin(SubagentRuntime)
let selectedStarts = 0
ctx.subagents.registerProvider({
  name: 'built-selected',
  capabilities: { outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async start() {
    selectedStarts += 1
    return {
      id: 'built-child',
      result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    }
  },
})
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'must-not-be-used' })
const run = ctx.workflowEngine.start({
  script: "const value = await agent('answer', { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } }); return value.answer",
  meta: { name: 'built-smoke', description: 'built worker smoke' },
  subagentProvider: 'built-selected',
  parent: { id: 'built-smoke-parent', options: {} },
})
const result = await run.result
await run.dispose()
if (result.stopReason !== 'completed' || result.value !== 42 || selectedStarts !== 1) {
  console.error('unexpected result: ' + JSON.stringify(result))
  process.exit(1)
}
console.log('built-worker-smoke-ok')
`, 'utf8')
      const { stdout } = await run(process.execPath, [driver], { cwd: packageRoot, timeout: 60_000 })
      expect(stdout).toContain('built-worker-smoke-ok')
    } finally {
      await rm(driver, { force: true })
    }
  }, 120_000)
})

describe.skipIf(!existsSync(builtProcessWorker))('built process worker entry (lib/process-worker.cjs)', () => {
  it('runs the JSONL process entry under plain Node without tsx', async () => {
    const result = await runProcessWorker()
    expect(result).toMatchObject({ code: 0, stderr: '' })
    const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(messages).toContainEqual({ type: 'ready' })
    expect(messages).toContainEqual({
      type: 'result',
      result: { value: 42, stopReason: 'completed', agentsStarted: 0 },
    })
  })
})

describe.skipIf(!bwrapUsable)('sandboxed process workflow isolation', () => {
  it('keeps agent() working while hiding host workspaces, credentials, Conda, env, and network', async () => {
    const hostRoot = await mkdtemp(join(homedir(), '.dsh-workflow-isolation-'))
    const otherWorkspace = join(hostRoot, 'other-user', 'workspace')
    const credentials = join(hostRoot, 'other-user', '.credentials.yaml')
    const condaEnvironment = join(hostRoot, 'miniconda', 'envs', 'other-user')
    await mkdir(otherWorkspace, { recursive: true })
    await mkdir(condaEnvironment, { recursive: true })
    await writeFile(join(otherWorkspace, 'canary.txt'), 'private workspace', 'utf8')
    await writeFile(credentials, 'token: private', 'utf8')
    await writeFile(join(condaEnvironment, 'conda-meta-history'), 'private env', 'utf8')
    process.env.DSH_WORKFLOW_HOST_SECRET = 'must-not-cross-process-boundary'

    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let starts = 0
    const provider: SubagentProvider = {
      name: 'stub',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start() {
        starts += 1
        return {
          id: SessionId(`sandbox-child-${starts}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'sandbox answer' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        }
      },
    }
    ctx.subagents.registerProvider(provider)
    const engine = await ctx.plugin(WorkerThreadWorkflowEngine, {
      provider: 'stub', execution: 'sandboxed-process', disposeGraceMs: 2_000,
    })
    const parent = { id: SessionId('sandbox-parent'), options: {} } as unknown as Agent
    try {
      const ordinary = ctx.workflowEngine.start({
        script: "return await agent('answer normally')",
        meta: { name: 'ordinary', description: 'ordinary sandboxed agent call' },
        parent,
      })
      await expect(ordinary.result).resolves.toMatchObject({
        value: 'sandbox answer', stopReason: 'completed', agentsStarted: 1,
      })
      await ordinary.dispose()

      const paths = [join(otherWorkspace, 'canary.txt'), credentials, join(condaEnvironment, 'conda-meta-history')]
      const escapedScript = `
        const hostProcess = globalThis.constructor.constructor('return process')()
        const fs = hostProcess.getBuiltinModule('node:fs')
        const net = hostProcess.getBuiltinModule('node:net')
        const timers = hostProcess.getBuiltinModule('node:timers')
        const paths = ${JSON.stringify(paths)}
        const network = await new Promise((resolve) => {
          const socket = net.connect({ host: '1.1.1.1', port: 80 })
          const timer = timers.setTimeout(() => { socket.destroy(); resolve(true) }, 1000)
          socket.once('connect', () => { timers.clearTimeout(timer); socket.destroy(); resolve(true) })
          socket.once('error', () => { timers.clearTimeout(timer); resolve(false) })
        })
        fs.writeFileSync('/tmp/private.txt', 'ok')
        let rootWritable = true
        try { fs.writeFileSync('/host-write.txt', 'denied') } catch { rootWritable = false }
        return {
          visible: paths.map((path) => fs.existsSync(path)),
          usrLocalVisible: fs.existsSync('/usr/local'),
          secret: hostProcess.env.DSH_WORKFLOW_HOST_SECRET ?? null,
          cwd: hostProcess.cwd(),
          tmpWritable: fs.readFileSync('/tmp/private.txt', 'utf8') === 'ok',
          rootWritable,
          network,
        }
      `
      const escaped = ctx.workflowEngine.start({
        script: escapedScript,
        meta: { name: 'escape-probe', description: 'verify host isolation after VM escape' },
        parent,
      })
      await expect(escaped.result).resolves.toEqual({
        value: {
          visible: [false, false, false], usrLocalVisible: false, secret: null, cwd: '/tmp',
          tmpWritable: true, rootWritable: false, network: false,
        },
        stopReason: 'completed',
        agentsStarted: 0,
      })
      await escaped.dispose()
    } finally {
      delete process.env.DSH_WORKFLOW_HOST_SECRET
      await engine.dispose()
      await ctx.fiber.dispose()
      await rm(hostRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
