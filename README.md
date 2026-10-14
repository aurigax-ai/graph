# @aurigax-ai/graph

A state graph interpreter for long activities that happen outside the process: coding agents,
questions for a human, commands and waits. A graph is a YAML file of nodes, edges and a typed
state. Every step is written to a journal, so a run survives a restart: a node that was waiting
is picked up again, and a node that was cut off starts again or waits for a human's choice.

It is the engine behind the Graphs feature of [Ostia](https://github.com/aurigax-ai/ostia), and
it runs on its own as a command or a library.

## Install

```sh
pnpm add @aurigax-ai/graph
```

Node 22 or later.

## The command

```sh
graph validate review.yaml
graph explain review.yaml
graph dry-run review.yaml --input task="fix the total" --mock review='{"verdict":"pass"}'
graph run review.yaml --input task="fix the total"
graph show <run>
```

`schema` prints the graph file's JSON Schema and `nodes` lists the node kinds the headless host
runs. `run` keeps its runs under `.graph/runs` in the current folder (`--data <dir>` to change it).
The headless host runs `command`, `router`, `wait` and `notify` nodes; nodes that need an agent or
a human are for a host that has them.

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
import { Engine, FileJournalStore, commandNode, readGraphFile, realClock } from '@aurigax-ai/graph'

const engine = new Engine({
  host: { name: 'my-host', contract: 1, kinds: [commandNode(runner)], triggers: ['manual'],
    clock: realClock, notify: (notice) => console.log(notice.title) },
  store: new FileJournalStore('runs', () => Date.now()),
  changed: () => {},
})
```

A node kind returns `done` with its output or `waiting` with what it waits for; the wait is stored,
and `resume` completes it when the event arrives, also after a restart. `@aurigax-ai/graph/testing`
has a fake clock, fake agent and approval kinds, and `contractFailures`, the suite a host's kinds
must pass.

## License

[FSL-1.1-MIT](LICENSE): source available now, MIT two years after each release.
