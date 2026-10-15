# Wire Runtime contract

contract: 1

The Graph Runtime (`wire runtime`, process `wire-runtime`) speaks JSON-RPC 2.0 over a Unix socket,
each message framed by a `Content-Length` header as in the Language Server Protocol. A client
first sends `hello` with this contract number and its token; every other request before it is
refused with `hello-first`. A change to this file that is not an addition is `contract: 2`, and
a runtime refuses a client that speaks another number with `unsupported-contract`.

## Where

| | Linux | macOS |
|---|---|---|
| Socket | `$XDG_RUNTIME_DIR/wire/runtime.sock`, else `$TMPDIR/wire-<uid>/runtime.sock` | `$TMPDIR/wire/runtime.sock` |
| Data | `$XDG_STATE_HOME/wire` (`~/.local/state/wire`) | `~/Library/Application Support/wire` |

Both folders are 0700 and owned by the user; the runtime refuses a folder that is a link or
another user's. The socket and every file in the data folder are 0600. One runtime runs per data
folder: the lock is held by the kernel and ends with the process (on Linux an abstract socket named
from the data folder's private `lock-id`, on macOS an exclusive lock on `runtime.lock`), and
`runtime.lock` names the holder's pid. A second start exits with `already-running` and that pid.
Clients find the runtime's pid by asking it (`runtime.status`), never from the file.

## Tokens and rights

A token is 32 random bytes. The runtime writes the CLI's token to `<data>/tokens/cli` at its first
start, with `observe`, `start` and `ingest`; a client that needs more is paired once.
`wire runtime tokens revoke <client>` revokes a token and closes the client's connections.

| Right | Allows |
|---|---|
| `observe` | status, lists, runs and the events |
| `start` | starting a graph whose manual trigger says `agents: true`, in a scope the client registered |
| `control` | pause, resume, cancel, retry and the `once` choices |
| `ingest` | pushing command and agent events |
| `worker` | registering node kinds and taking their tasks |
| `enable` | enabling and disabling a graph |

## Errors

An error's `message` is its code, with detail after a colon where there is any:
`hello-first`, `already-hello`, `unsupported-contract`, `unauthorized`, `too-many-clients`,
`needs-right: <right>`, `method-not-found` (JSON-RPC code -32601), `internal: <text>`. Every other
error has JSON-RPC code -32000.

## Methods

| Method | Right | Params | Result |
|---|---|---|---|
| `hello` | | `{ contract, token }` | `{ contract, version, pid, mode, client, rights }` |
| `runtime.status` | `observe` | `{}` | `{ pid, version, contract, mode, clients }` |
| `scopes.register` | `observe` | `{ folder, sandboxed?, scratch? }` | `{ scope, folder, sandboxed }` |
| `graphs.load` | `observe` | `{ scope, path }` | a graph |
| `graphs.unload` | `observe` | `{ scope, name }` | `{ ok }` |
| `graphs.list` | `observe` | `{ scope }` | graphs |
| `graphs.enable` | `enable` | `{ scope, name, fingerprint }` | a graph |
| `graphs.disable` | `enable` | `{ scope, name }` | a graph |
| `runs.list` | `observe` | `{ scope }` | run summaries |
| `runs.show` | `observe` | `{ scope, runId, node? }` | a run, node by node |
| `runs.start` | `start` | `{ scope, name, input?, inputs?, by? }` | `{ runId }` or `{ queued: true }` |
| `runs.control` | `control` | `{ scope, runId, action, node? }` | `{ ok }` |
| `worker.register` | `worker` | `{ kinds, scopes }` | `{ kinds }` |
| `events.push` | `ingest` | `{ scope, event }` | `{ matched }` |
| `pair.request` | `observe` | `{ client, rights }` | `{ id, expiresAt }` |
| `pair.confirm` | `observe` | `{ id }` | `{ token, client, rights }` |

A scope is a real folder, `dir:<real path>`, the same for every client. `scopes.register` resolves
the folder and refuses a scratch one (`scratch`); only a client with `worker` sets or clears its
`sandboxed` flag, which the runtime keeps in `<data>/scopes.json` until that client clears it. A
client loads, unloads and starts graphs only in scopes it registered on its connection; a graph
file is read only inside its scope's folder, and again at every list and start.

A graph is `{ scope, name, path, state, fingerprint?, manual?: { agents, input }, problems }`, with
`state` one of `enabled`, `changed`, `not-enabled`, `invalid`. `graphs.enable` needs the
fingerprint the client showed (`changed` when the file differs); a change outside `ui` disables the
graph, and enable records live in `<data>/enabled.json`. `runs.start` starts only an enabled graph
with a manual trigger: a client with `control` may say `by: "human"`, any other start is an
agent's and needs `agents: true` on the trigger (`not-for-agents`). `input` is an object, `inputs`
a list of `key=value`. `action` is `pause`, `resume`, `cancel`, `retry`, or `rerun`, `skip` and
`continue` for an interrupted `node`.

## Workers

A worker runs the node kinds the runtime does not run itself: `agent`, `approval`, `notify`,
`connector`, and `command` in a folder it serves. `worker.register` names the kinds and the scopes
(registered on the same connection) it serves; at most 8 workers serve one folder. The runtime
runs `router`, `wait`, and `command` headless only in a folder no worker serves and that is not
sandboxed. A `connector` step in a sandboxed folder fails `ConnectorFailed`.

The runtime sends each step to a worker as a request, `worker.task`:

`{ op, kind, scope, folder, run, node, trigger, timeoutMs, history, input?, wait?, started?, event? }`

with `op` one of `start`, `resume` (an event for its wait), `reattach` (after the runtime or the
worker went away), `cancel` and `rearm`. The worker answers `{ done }`, `{ waiting, started? }`,
`{ lost: true }` (reattach only: the work is gone), `{ error: { name, message } }`, or `{ ok }` for
`cancel` and `rearm`. With no worker for its kind and folder, a step waits as pending
(`{ on: "worker" }`, shown as `pending`) and its timeout does not run; when a worker registers it
starts once and its timeout starts then. When a worker goes away during a step, the step is
reattached through the next worker instead of started again.

`events.push` delivers an event (`{ type, ... }`, such as an agent's stop or an answer) to the
waiting steps of one of the client's scopes; `worker-ready` is the runtime's own.

## Pairing

A client that needs rights beyond the CLI's asks with `pair.request` and, after its own human said
yes, confirms on the same connection with `pair.confirm` within 2 minutes. The token is returned
once. A pairing confirmed from another connection, late or twice issues nothing.

`mode` is `client` (the runtime exits 60 s after its last client leaves while no step is running
or waiting on a timer) or `daemon` (started with `--daemon`; it runs until `wire runtime stop`).

## Events

The runtime sends events as notifications to every client holding their right.

| Event | Right | Params |
|---|---|---|
| `graph.changed` | `observe` | `{ scope, name, state?, notice?: { title, body? }, runId? }` |
| `node.changed` | `observe` | `{ scope, runId, node, type }` |
| `run.changed` | `observe` | `{ scope, runId, graph, status }` |
| `worker.changed` | `observe` | `{ workers: [{ client, kinds, scopes }] }` |
