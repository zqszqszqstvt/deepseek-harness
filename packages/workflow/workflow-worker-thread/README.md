# @deepseek-ai/dsh-workflow-worker-thread

English | [中文](README.zh.md)

This package implements `WorkflowEngine` with one isolated execution peer per run. The default peer is a Node worker thread; Linux deployments may select a bubblewrap-confined Node process. The peer executes the orchestration script; child agents remain on the host and are reached through `ctx.subagents` over a typed protocol.

The package root exports the default engine plugin and its `Config`; the worker protocol, runtime, and session modules stay private to the implementation. The operational `./worker` and `./process-worker` entries are the engine's two spawn targets.

Both peers keep a synchronous script loop off the harness event loop and let disposal terminate a script that ignores cancellation. The worker-thread mode is not a security sandbox; the process mode adds an operating-system security boundary for multi-user deployments.

## Trust and isolation boundary

Workflow scripts are model-written. `node:vm` is an API-shaping mechanism, not a security boundary: an escaped script can recover Node capabilities from whichever process executes it. The execution mode determines what those capabilities can reach.

The default `worker-thread` mode provides useful operational containment but shares the Server process authority:

- Script CPU work and synchronous spins stay off the host event loop.
- `worker.terminate()` gives disposal a real final stop.
- The worker starts with an empty environment, except unbuilt loader plumbing, so ambient credentials do not cross through `process.env`.
- Host/worker messages use structured-clone data, with plain-JSON validation at the script boundary.

The Linux-only `sandboxed-process` mode preserves the same workflow hooks while placing the script in a fresh bubblewrap mount, PID, IPC, UTS, session, and network namespace. It exposes only the Node executable, required system library directories, the single built `process-worker.cjs` entry, `/dev`, `/proc`, and a private writable `/tmp`; it does not mount the Server data root, user workspaces, home directories, `/run`, `/etc`, host commands, `/usr/local`, global Conda installations, or the source repository. The child environment is cleared and networking is unavailable. Process-to-host JSONL frames are byte-bounded and rebuilt through host-side validation; the host independently enforces child-call identities and totals. A `node:vm` escape therefore remains inside this process sandbox instead of recovering Server authority.

## Script contract

The workflow's `meta` is host-provided data, not evaluated script text. The engine validates its required `name` and `description`, rejects unknown fields, and parse-checks the body before returning a run.

Inside the worker, the script receives `args` and these hooks:

- `agent(prompt, { label, phase, schema, model })` starts one host-side subagent. With a schema it returns the structured value; otherwise it returns final text. An ordinary failed child yields `null`.
- `parallel(thunks)` runs thunks under the configured concurrency limit.
- `pipeline(items, ...stages)` passes `(previous, item, index)` without a cross-stage barrier.
- `phase(title)` and `log(message)` emit observer narration.

Unknown options, malformed arguments, unsupported schemas, tripped caps, provider-start failures, and infrastructure result failures are fatal workflow errors. No timers, filesystem API, or Node globals are intentionally injected, though the trust caveat above still applies.

## Run sequence

`start()` validates meta, parses the body, resolves a registered normalized provider route, and resolves any per-run total-child cap before creating an execution peer or publishing `workflow/start`. A requested `maxTotalAgents` must be a positive safe integer no greater than the engine's configured deployment ceiling. Worker-thread source mode installs TypeScript transforms through a data-URL bootstrap; built mode passes sibling `lib/worker.cjs` as a filesystem path because pkg's VFS hook expects CommonJS. Sandboxed-process mode requires the built sibling `lib/process-worker.cjs`, so it never mounts the source repository. A ready/go handshake prevents a start-signal cancellation racing peer boot from executing the script's initial synchronous slice.

For each `agent()` call:

1. The worker sends `child-start` with a plain-data prompt and options.
2. The host calls the start request's provider override, or otherwise the configured provider, through async `SubagentRuntime.start`, passing the workflow's parent and one canonical per-run abort signal. Provider choice applies to every child in that run and is not visible to the script.
3. If start rejects, the host sends `child-start-error`; provider startup has already reached quiescence and no child lifecycle event is emitted.
4. If start fulfills while the workflow still admits work, the host records the run, observes `result`, then sends `child-started`. Even an already-settled result is forwarded afterward, preserving start-before-result order.
5. The worker emits paired `workflow/agent-start` and `workflow/agent-end` narration and requests child disposal after collection.

Provider starts are tracked separately from published children. If cancellation, worker death, or normal workflow settlement closes admission while a start is pending, the shared signal aborts it. A provider that nevertheless fulfills after closure is disposed by the host and never announced to the worker.

## Value boundary

Values leaving the script pass through `materializeFromRealm`, which accepts plain, lossless JSON data and rejects exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers, and nested `undefined`. The walk runs in the worker, and defines object keys as data properties so `__proto__` cannot mutate a prototype.

Child results are projected and snapshotted before crossing from the host to the worker. This is a real process-like serialization boundary; it is deliberately different from trusted same-process workflow and subagent event payloads, which are borrowed immutable values.

## Cancellation and disposal

`WorkflowRun.cancel()` records the first reason, tells the worker to cancel, aborts the one signal shared by every pending and published child, and arms the `disposeGraceMs` timer. Worker hooks then throw `CANCELLED` at their next await. If the run remains unsettled at the deadline, the host resolves it as cancelled, pairs stranded child lifecycle events, and terminates the worker.

The subagent seam has one cancellation channel: the request signal. There is no separate child-cancel RPC. Published child teardown uses `run.dispose()`; pending provider starts remain provider-owned until their promise rejects or fulfills.

Normal settlement also aborts pending starts and begins disposing any published fire-and-forget children before the result becomes externally settled. The host's quiescence condition includes both pending starts and published child disposals, so cleanup does not forget an async startup transaction.

`dispose()` is idempotent. It cancels the run, starts host-driven disposal immediately, waits for result plus child quiescence up to the same grace, terminates the worker unconditionally, and performs a final survivor sweep. Per-child disposal is memoized so worker RPC, host cancellation, death cleanup, and public disposal all join one operation.

## Outcome and event guarantees

Terminal outcome is first-wins at host claim points. An accepted external cancellation overrides a later non-cancelled worker result; a result or worker death that claims first cannot be rewritten by reentrant cleanup callbacks.

Worker error, message failure, or premature exit closes message admission before cleanup, then resolves `error` unless cancellation already owns the run. Late queued messages cannot create children or narrate after that logical boundary.

The host keeps a ledger of forwarded child starts. A graceful peer supplies their ends; death or force termination synthesizes any missing end as cancelled. For an untrusted process peer, lifecycle messages must name a real host-published child with an unused identity, terminal identity must match its accepted start, and `agentsStarted` comes from the host rather than the process. Every forwarded `workflow/agent-start` is therefore paired exactly once, although cleanup after an already-arrived workflow result may complete afterward.

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Host-side subagent provider used by `agent()`. |
| `execution` | `worker-thread` | Execution boundary: `worker-thread` or Linux-only `sandboxed-process`. |
| `bwrapPath` | `bwrap` | Bubblewrap executable used by `sandboxed-process`. |
| `maxProtocolFrameBytes` | `1048576` | Maximum bytes accepted for one process JSONL frame or total stderr output. |
| `maxConcurrentAgents` | `0` | Concurrent `agent()` ceiling; `0` resolves from available CPU parallelism. |
| `maxTotalAgents` | `1000` | Total `agent()` calls in one run. |
| `maxItemsPerCall` | `4096` | Items accepted by one `parallel()` or `pipeline()` call. |
| `syncTimeoutMs` | `5000` | VM timeout for the script's initial synchronous slice. |
| `disposeGraceMs` | `5000` | Bound before force-settlement/termination and for public disposal. |

An owning consumer may set `WorkflowStartRequest.subagentProvider` and `WorkflowStartRequest.maxTotalAgents` for one run. These are engine-level policy, not script hooks or model-facing options; the ordinary `workflow` tool leaves both unset. A per-run total-child cap may lower but never raise the configured `maxTotalAgents` ceiling.

## Model Experience

### Child-agent requests

#### What the model sees

Every script `agent()` call sends its prompt verbatim and optional model or structured-output schema to a subagent provider. Each child sees that provider's own context; phase and log narration stays on observer events.

#### Token effect

Potentially many independent child contexts are paid, bounded by `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`; they never join the parent history directly.

#### KV Cache effect

Independent of the parent request cache and of sibling children. Each child can reuse only a byte-identical prefix under its own provider, model, prompt, and schema; its later history grows append-only.

### Parent tool result, indirectly

#### What the model sees

Through [`dsh-tool-workflow`](../tool-workflow/README.md), success exposes only the materialized final JSON value and child count in that consumer's wrapper. This engine supplies stable errors including `workflow script does not parse: <error>`, `invalid meta: <violations>`, `agent() requires a non-empty prompt string`, `agent() could not start a child: <error>`, `child agent run failed: <error>`, and its exact `parallel()`, `pipeline()`, `phase()`, option, schema, and JSON-boundary validation messages. Intermediate child outputs are available to the script but not the parent model.

#### Token effect

Zero direct parent tokens from this engine. Final result size is capped by the tool consumer and retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Worker-thread mode is not a security boundary** — model-written code can escape `node:vm` and reach the host process authority; multi-user deployments must select `sandboxed-process` or provide an equivalent outer container.
- **Sandboxed-process mode requires Linux, usable bubblewrap, and built package artifacts** — it fails closed when its process entry cannot be found or launched.
- **One worker thread or process is paid per run** — there is no pool, warm runtime, or cross-run script cache; the process mode adds process and namespace startup cost.
- **No CPU or memory quota is applied** — namespaces isolate authority and shared files, not hardware consumption; deployment-level cgroups remain the operator's responsibility.
- **No ambient timers, filesystem, or network are injected into the VM** — in worker-thread mode an escape can still reach Node; in sandboxed-process mode escaped Node access remains confined.
- **Termination can only report host-observed starts** — `agentsStarted` excludes worker-side calls still queued behind concurrency when a forced termination makes them unknowable.
- **Cross-realm errors fail `instanceof Error` inside scripts** — workflow authors must branch on stable fields such as `name` and `code`.
