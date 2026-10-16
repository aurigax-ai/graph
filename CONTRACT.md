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
Clients find the runtime's pid by asking it (`runtime.status`), never from the file. A runtime
also holds a second lock of the same kind in its socket folder (`socket-lock-id`, `socket.lock`)
for its whole life, taken before it looks at the socket. It refuses to start (`socket-in-use`)
while another runtime holds that lock, or while anything answers on the socket, or when the
socket gives any answer but "refused" or "not there" within a second (a full backlog, for
instance); only then does it remove the old socket file and listen.

## Tokens and rights

A token is 32 random bytes. The runtime writes the CLI's token to `<data>/tokens/cli` at its first
start, with `observe`, `start` and `ingest`. There is no pairing over the socket: a host that needs
more rights writes its own token file, `<data>/tokens/<client>` (0600, JSON
`{ "token": "...", "rights": [...] }`, `provisionToken` in the package does it), before it starts
the runtime or connects to it, and sends a running runtime SIGHUP. The runtime reads token files
only from `<data>/tokens/`, at its start and on SIGHUP, and refuses and logs a file that is a link,
another user's, readable by others, or not such an object.
`wire runtime tokens revoke <client>` revokes a token (removing its file) and closes the client's
connections.

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
error has JSON-RPC code -32000. `unsupported-contract` carries `data: { contract, version }`, the runtime's
own, so a client can say which runtime it met.

## Methods

| Method | Right | Params | Result |
|---|---|---|---|
| `hello` | | `{ contract, token }` | `{ contract, version, pid, mode, client, rights }` |
| `runtime.status` | `observe` | `{}` | `{ pid, version, contract, mode, clients, skipped, rateLimited }` |
| `scopes.register` | `observe` | `{ folder, sandboxed?, scratch? }` | `{ scope, folder, sandboxed }` |
| `graphs.load` | `observe` | `{ scope, path }` | a graph |
| `graphs.unload` | `observe` | `{ scope, name }` | `{ ok }` |
| `graphs.list` | `observe` | `{ scope }` | graphs, each with `skipped`, the starts the runtime skipped, and `filesRefused` when its folder has too many folders to watch |
| `graphs.enable` | `enable` | `{ scope, name, fingerprint }` | a graph |
| `graphs.disable` | `enable` | `{ scope, name }` | a graph |
| `runs.list` | `observe` | `{ scope }` | run summaries |
| `runs.show` | `observe` | `{ scope, runId, node? }` | a run, node by node, with its `graph` |
| `runs.waiting` | `observe` | `{ scope, event }` | `[{ runId, graph, node }]`, the steps that event would reach |
| `runs.report` | `worker` | `{ scope, runId, node, valid }` | `{ ok }`, journals whether a report was valid |
| `runs.start` | `start` | `{ scope, name, input?, inputs?, by?, pane? }` | `{ runId }` or `{ queued: true }` |
| `runs.control` | `control` | `{ scope, runId, action, node? }` | `{ ok }` |
| `runtime.ceilings` | `control` | `{ steps?, runsPerHour?, parallel?, agents?, timeMs? }` | the ceilings |
| `worker.register` | `worker` | `{ kinds, scopes }` | `{ kinds }` |
| `events.push` | `ingest` | `{ scope, event?, trigger? }` | `{ matched, fired }` |

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
`continue` for an interrupted `node`. `pane` names the pane a start came from; it is the trigger's `pane`.

## Workers

A worker runs the node kinds the runtime does not run itself: `agent`, `approval`, `notify`,
`connector`, and `command` in a folder it serves. `worker.register` names the kinds and the scopes
(registered on the same connection) it serves; at most 8 workers serve one folder. The runtime
runs `router`, `wait`, and `command` headless only in a folder no worker serves and that is not
sandboxed. A `connector` step in a sandboxed folder fails `ConnectorFailed`.

The runtime sends each step to a worker as a request, `worker.task`:

`{ op, kind, scope, folder, run, node, trigger, timeoutMs, history, input, wait?, started?, event? }`

where `input` is the step's own input.

with `op` one of `start`, `resume` (an event for its wait), `reattach` (after the runtime or the
worker went away), `cancel` and `rearm`. The worker answers `{ done }`, `{ waiting, started? }`,
`{ lost: true }` (reattach only: the work is gone), `{ error: { name, message } }`, or `{ ok }` for
`cancel` and `rearm`. With no worker for its kind and folder, a step waits as pending
(`{ on: "worker" }`, shown as `pending`) and its timeout does not run; when a worker registers it
starts once and its timeout starts then. When a worker goes away during a step, the step is
reattached through the next worker instead of started again. A worker that starts serving a kind
in a folder (a new connection, or a kind or folder it did not serve) has every waiting step of
that kind there, and every step left pending by a worker that went away, reattached through it as
after a restart: `{ waiting }` with the same wait keeps the step waiting and re-arms it, another
`{ waiting }` waits on that, `{ done }` ends it, and `lost` interrupts a step that runs once
(`agent`) and starts any other again as its next attempt, with its own input and the same attempt
key. Registering the same kinds and folders again reattaches nothing.

`events.push` delivers an event (`{ type, ... }`, such as an agent's stop or an answer) to the
waiting steps of one of the client's scopes; `worker-ready` is the runtime's own. Its `trigger`,
`{ kind: "command", pane, exitCode }` or `{ kind: "agent", pane, state: "stopped" | "waiting",
agent? }`, starts the enabled graphs of that scope whose `command` or `agent` trigger it matches,
except a graph one of whose runs opened the pane, ended runs and runs before a restart included
(the runtime rebuilds this from every stored journal when it starts). A client sends at most 100 events a second; more
are refused with `rate-limited` and counted in `runtime.status`.

## Triggers and limits

The runtime holds the one scheduler and trigger host for every enabled graph: `schedule`
triggers (last times in `<data>/schedules.json`), `files` triggers (it watches the folder,
following `.gitignore`, never `.git`, `node_modules` or a link, at most 5000 folders), and the
`command` and `agent` triggers clients push. A graph is read again before a trigger starts it, so
a changed graph never fires. A runtime that is not a daemon fires nothing while it is not running;
when it starts again, a schedule's `catchUp` decides whether a missed time fires once. Besides each
graph's own limits, at most 16 runs are active and 240 runs start in an hour across the runtime;
a start over either is `skipped`, naming the limit, and counted in `runtime.status`. A client
with `control` sets ceilings no graph's own `limits` pass (`runtime.ceilings`, at most 500 steps,
60 runs an hour, 8 in parallel, 24 agents and 168 hours; a ceiling left out keeps its value, and
each value is a whole number); they are kept in `<data>/ceilings.json`
and apply also while that client is away.

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
