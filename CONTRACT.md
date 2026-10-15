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

`mode` is `client` (the runtime exits 60 s after its last client leaves while no run is active
or waiting on a timer) or `daemon` (started with `--daemon`; it runs until `wire runtime stop`).

## Events

The runtime sends events as notifications to every client holding their right.

| Event | Right | Params |
|---|---|---|
