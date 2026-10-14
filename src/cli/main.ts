import { resolve } from 'node:path'
import { Engine } from '../engine/engine.ts'
import { FileJournalStore } from '../engine/fileStore.ts'
import { parseInputs } from '../engine/inputs.ts'
import { isEnded } from '../engine/runState.ts'
import { runView } from '../engine/summary.ts'
import { readGraphFile } from '../format/graphFile.ts'
import {
  type CommandOutput,
  dryRunCommand,
  explainCommand,
  nodesCommand,
  schemaCommand,
  validateCommand,
} from './commands.ts'
import { headlessHost } from './headlessHost.ts'

const USAGE = `usage: graph <command>
  validate <file>                 check a graph file
  schema                          print the graph file's JSON Schema
  nodes                           list the node kinds this host runs
  explain <file>                  print an outline of a graph
  dry-run <file> [--input k=v]... [--input-json <json>] [--mock <node>=<json>]... [--json]
  run <file> [--input k=v]... [--data <dir>]   run a graph here until it ends
  show <run> [--data <dir>] [--node <id>]       print a run node by node`

function flags(argv: string[]): {
  values: Record<string, string[]>
  bools: Set<string>
  rest: string[]
} {
  const values: Record<string, string[]> = {}
  const bools = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--json') bools.add('json')
    else if (arg.startsWith('--') && i + 1 < argv.length) {
      const name = arg.slice(2)
      values[name] = [...(values[name] ?? []), argv[++i] as string]
    } else rest.push(arg)
  }
  return { values, bools, rest }
}

async function runHere(
  path: string,
  cwd: string,
  data: string,
  inputs: string[],
): Promise<CommandOutput> {
  const loaded = readGraphFile(path, cwd)
  if (!loaded.ok)
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({ ok: false, problems: loaded.problems }, null, 2)}\n`,
    }
  const input = parseInputs(loaded.value.graph, inputs)
  if (!input.ok)
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({ ok: false, problems: [input.problem] }, null, 2)}\n`,
    }
  const host = headlessHost({
    cwd,
    log: (n) => process.stderr.write(`notify: ${n.title}${n.body ? ` — ${n.body}` : ''}\n`),
  })
  const engine = new Engine({ host, store: new FileJournalStore(data) })
  const res = engine.start(
    'local',
    { name: loaded.value.name, graph: loaded.value.graph, fingerprint: loaded.value.fingerprint },
    {},
    input.input,
  )
  if (!res.ok || !('runId' in res))
    return { exitCode: 1, stdout: `${JSON.stringify(res, null, 2)}\n` }
  const run = engine.run(res.runId)
  await new Promise<void>((done) => {
    const tick = setInterval(() => {
      if (!run || isEnded(run.state.status)) {
        clearInterval(tick)
        done()
      }
    }, 100)
  })
  return {
    exitCode: run?.state.status === 'done' ? 0 : 1,
    stdout: `${JSON.stringify({ runId: res.runId, status: run?.state.status }, null, 2)}\n`,
  }
}

function show(runId: string, data: string, node?: string): CommandOutput {
  const store = new FileJournalStore(data)
  const key = store.list().find((k) => k.runId === runId)
  const stored = key ? store.read(key) : null
  const graph = (stored?.definition as { graph?: Parameters<typeof runView>[1] } | undefined)?.graph
  if (!key || !stored || !graph)
    return { exitCode: 1, stdout: `${JSON.stringify({ ok: false, error: 'unknown-run' })}\n` }
  const view = runView(key, graph, stored.lines)
  const nodes = node ? view.nodes.filter((n) => n.node === node) : view.nodes
  return { exitCode: 0, stdout: `${JSON.stringify({ ...view, nodes }, null, 2)}\n` }
}

export async function main(argv: string[], cwd = process.cwd()): Promise<CommandOutput> {
  const [command, ...rest] = argv
  const parsed = flags(rest)
  const file = parsed.rest[0] ? resolve(cwd, parsed.rest[0]) : undefined
  const data = resolve(cwd, parsed.values.data?.[0] ?? '.graph/runs')
  switch (command) {
    case 'validate':
      return file ? validateCommand(file, cwd) : { exitCode: 2, stdout: `${USAGE}\n` }
    case 'schema':
      return schemaCommand()
    case 'nodes':
      return nodesCommand(headlessHost({ cwd, log: () => {} }).kinds.map((k) => k.kind))
    case 'explain':
      return file ? explainCommand(file, cwd) : { exitCode: 2, stdout: `${USAGE}\n` }
    case 'dry-run':
      if (!file) return { exitCode: 2, stdout: `${USAGE}\n` }
      return dryRunCommand({
        path: file,
        workDir: cwd,
        inputs: parsed.values.input ?? [],
        mocks: parsed.values.mock ?? [],
        json: parsed.bools.has('json'),
        ...(parsed.values['input-json'] ? { inputJson: parsed.values['input-json'][0] } : {}),
      })
    case 'run':
      return file
        ? runHere(file, cwd, data, parsed.values.input ?? [])
        : { exitCode: 2, stdout: `${USAGE}\n` }
    case 'show':
      return parsed.rest[0]
        ? show(parsed.rest[0], data, parsed.values.node?.[0])
        : { exitCode: 2, stdout: `${USAGE}\n` }
    default:
      return { exitCode: 2, stdout: `${USAGE}\n` }
  }
}
