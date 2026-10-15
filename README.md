# @aurigax-ai/wire

A state graph interpreter for long activities that happen outside the process: coding agents,
questions for a human, commands and waits. A graph is a YAML file of nodes, edges and a typed
state. Every step is written to a journal, so a run survives a restart: a node that was waiting
is picked up again, and a node that was cut off starts again or waits for a human's choice.

It is the engine behind the Graphs feature of [Ostia](https://github.com/aurigax-ai/ostia), and
it runs on its own as a command or a library. Up to 0.1.1 it was published as
`@aurigax-ai/graph`.

## Install

```sh
pnpm add @aurigax-ai/wire
```

Node 22 or later.

## The command

```sh
wire validate review.yaml
wire explain review.yaml
wire dry-run review.yaml --input task="fix the total" --mock review='{"verdict":"pass"}'
wire run review.yaml --input task="fix the total"
wire show <run> --data .wire/runs
```

`schema` prints the graph file's JSON Schema and `nodes` lists the node kinds the headless host
runs. `run` keeps its runs under `.wire/runs` in the current folder (`--data <dir>` to change it), and `show` reads them with `--data`.
The headless host runs `command`, `router`, `wait` and `notify` nodes; nodes that need an agent or
a human are for a host that has them.

## The Graph Runtime

`wire runtime` is one long-running process per user, shown as `wire-runtime`, that clients reach
over a Unix socket (JSON-RPC 2.0 with `Content-Length` framing; the methods, rights and errors are
in [CONTRACT.md](CONTRACT.md)). Its data is in `$XDG_STATE_HOME/wire` (macOS
`~/Library/Application Support/wire`) and its socket in `$XDG_RUNTIME_DIR/wire`; one runs per data
folder.

```sh
wire runtime start            # runs while a client is open, then exits 60 s after the last one leaves
wire runtime start --daemon   # keeps running with no client until it is stopped
wire runtime status           # whether it runs, its pid, version and mode
wire runtime stop             # lets started steps reach their next journal line, then exits
wire runtime tokens revoke <client>
```

In a folder, `wire list` shows the graphs the runtime holds for it, `wire start <name>` starts an
enabled graph whose manual trigger says `agents: true`, `wire runs` lists the folder's runs and
`wire show <run>` prints one node by node; each starts the runtime when none runs. A folder is
the runtime's scope (`dir:<real path>`), whichever client registered it. The CLI never enables a
graph: that right belongs to a host that provisioned its own token and asks its human, and a
change to a graph outside `ui` disables it again.

A host such as Ostia writes its own token file with `provisionToken` before it starts or connects
to the runtime (nothing pairs over the socket, so an agent holding the CLI's token cannot raise its
rights) and serves as a worker for the node kinds that need it: agents, approvals,
notices, connectors, and commands in the folders it serves. `serveKinds` from
`@aurigax-ai/wire` answers the runtime's `worker.task` requests with ordinary node kinds. A step
whose kind has no worker connected waits as `pending` without its timeout running, and starts
when a worker registers; a step whose worker goes away is reattached through the next one.

To keep it running across logins, install one of the documented files after putting your own two
paths in it, the Node it runs on (`command -v node`) and the package's `dist/cli/bin.js`
(`node -p "require.resolve('@aurigax-ai/wire/package.json').replace('package.json', 'dist/cli/bin.js')"`
from where it is installed); a version manager's shim is not enough, since a service has no shell:
[docs/systemd/wire-runtime.service](docs/systemd/wire-runtime.service) into
`~/.config/systemd/user/` (`systemctl --user enable --now wire-runtime`), or
[docs/launchd/com.aurigax.wire-runtime.plist](docs/launchd/com.aurigax.wire-runtime.plist) into
`~/Library/LaunchAgents/` (`launchctl load`). Both run `wire runtime start --daemon --foreground`
and restart it when it fails. What the runtime trusts, and what it does not defend against, is in
[SECURITY.md](SECURITY.md).

## A graph

```yaml
version: 1
description: Run the tests, and ask before opening the pull request.
on: [{ manual: {} }]
start: test
state:
  exit: { type: integer, default: -1 }
nodes:
  - { id: test, kind: command, timeout: 10m, with: { run: [pnpm, test] }, out: { exit: exit } }
  - { id: ask, kind: approval, with: { question: "Tests passed. Open the pull request?" } }
  - { id: open, kind: command, with: { run: [gh, pr, create, --fill] } }
edges:
  - from: test
    when: [{ if: "state.exit == 0", to: ask }]
    else: end
  - { from: ask, to: open }
```

Conditions are a small subset of CEL (`state.exit == 0`, `'bug' in state.labels`,
`run.visits.fix >= 3`), parsed and checked against the declared state; they are never evaluated as
code. Templates (`{{state.task}}`) are filled from the state the same way. `fixtures/` holds three
complete examples.

## Triggers

A graph starts from the triggers under `on`: `manual`, `schedule` (`every: 15m` or a five-field
`cron`, with `catchUp` to run once for times missed while the host was down), `files` (globs
relative to the workspace folder), `command` (a command that ended, by `exit`) and `agent` (an agent
that `stopped` or is `waiting`). The engine reads them: `TriggerScheduler` keeps the schedules on the
host's clock, `firedBy` tells which trigger an event fires and with what payload (`trigger.*` in
the graph), and `PathBatch` collects file changes made within a second into one event. The host
watches the files, commands and agents; `concurrency: skip` or `queue` decides what happens when
a run is still active. The headless command runs `manual` only.

## Connectors

A `connector` node calls something outside: `use: mcp:<server>/<tool>` calls a tool of an MCP
server the host has set up, and `use: <connector>.<operation>` calls a native connector. Its
outputs are `ok` and `data` (for MCP, `text` and, when the tool returns it, `structured`); a failure
raises `ConnectorFailed`. A graph names a `connection` by name only: the host keeps the connection's
fields and secrets and hands them to the connector for one call, so the file never holds a secret.

The one native connector is `http`. Its connection holds the base URL (with no user name or
password in it) and the auth (`bearer`, `header` or `basic`); a node gives `method`, `path`, `query`
and a JSON `body`. The path stays under the base URL: a `..` segment, raw or percent-encoded, an
encoded slash or a backslash is refused, and so is a redirect to another origin or outside the base
path. A response over 1 MiB fails the node and a call stops after 30 s. A field or secret with a
control character is refused before anything is sent, and a failure is reported with a fixed
message (`http: timeout after 30 s`, `http: connection refused`, `http: request failed`, …), never
the network library's own text, so a secret can't reach the run's journal through an error. `GET`
is a read and every other method a write
(`connectorUses` tells a host which, for its approval view). `connectorProblems` checks a graph
against the host's connectors and connections, and `connectorCatalog` lists them without a URL or
secret.

## As a library

A host gives the engine its node kinds, a clock and a way to notify; the engine keeps the runs.

```ts
import { Engine, FileJournalStore, commandNode, readGraphFile, realClock } from '@aurigax-ai/wire'

const engine = new Engine({
  host: { name: 'my-host', contract: 1, kinds: [commandNode(runner)], triggers: ['manual'],
    clock: realClock, notify: (notice) => console.log(notice.title) },
  store: new FileJournalStore('runs', () => Date.now()),
  changed: () => {},
})
```

A node kind returns `done` with its output or `waiting` with what it waits for; the wait is stored,
and `resume` completes it when the event arrives, also after a restart. `@aurigax-ai/wire/testing`
has a fake clock, fake agent and approval kinds, and `contractFailures`, the suite a host's kinds
must pass.

Runs are kept by a `JournalStore`, whose every method returns a promise: `FileJournalStore` (one
folder per run, each line written and synced before the run goes on) and `MemoryJournalStore`
(tests). A run's line is in the store before the step it records starts. Another store passes
`journalStoreFailures` from `@aurigax-ai/wire/testing` when it returns no failures; give it `tear`
and `break` when the store can lose a line's tail or refuse a write, so those are checked too.
`engine.start` answers once the run is in the store (`journal-failed` when it cannot be created);
`engine.recover` and `engine.summaries` return promises too.

## License

[FSL-1.1-MIT](LICENSE): source available now, MIT two years after each release.
