import { z } from 'zod'
import type { KindDescriptor } from '../engine/contract'
import { dryRun, parseMocks } from '../engine/dryRun'
import { explain } from '../engine/explain'
import { parseInputs } from '../engine/inputs'
import { readGraphFile } from '../format/graphFile'
import type { Problem } from '../format/model'
import { graphJsonSchema } from '../format/schema'
import { FORMAT_KINDS } from '../kinds/catalog'

export interface CommandOutput {
  exitCode: number
  stdout: string
}

function json(value: unknown, exitCode = 0): CommandOutput {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` }
}

function refused(problems: Problem[]): CommandOutput {
  return json({ ok: false, problems }, 1)
}

export function validateCommand(path: string, workDir: string): CommandOutput {
  const loaded = readGraphFile(path, workDir)
  if (!loaded.ok) return refused(loaded.problems)
  return json({
    ok: true,
    name: loaded.value.name,
    nodes: loaded.value.graph.nodes.length,
    edges: loaded.value.graph.edges.length,
  })
}

export function schemaCommand(): CommandOutput {
  return json(graphJsonSchema(FORMAT_KINDS))
}

export function kindSummary(kind: KindDescriptor) {
  return {
    kind: kind.kind,
    version: kind.version,
    title: kind.title,
    effect: kind.effect,
    sandbox: kind.sandbox,
    once: kind.once,
    fields: z.toJSONSchema(kind.with, { unrepresentable: 'any', io: 'input' }),
    outputs: z.toJSONSchema(kind.outputs, { unrepresentable: 'any' }),
  }
}

export function nodesCommand(kinds: readonly string[]): CommandOutput {
  return json(FORMAT_KINDS.filter((k) => kinds.includes(k.kind)).map(kindSummary))
}

export function explainCommand(path: string, workDir: string): CommandOutput {
  const loaded = readGraphFile(path, workDir)
  if (!loaded.ok) return refused(loaded.problems)
  return { exitCode: 0, stdout: `${explain(loaded.value.name, loaded.value.graph)}\n` }
}

export interface DryRunArgs {
  path: string
  workDir: string
  inputs: string[]
  inputJson?: string
  mocks: string[]
  json?: boolean
}

export async function dryRunCommand(args: DryRunArgs): Promise<CommandOutput> {
  const loaded = readGraphFile(args.path, args.workDir)
  if (!loaded.ok) return refused(loaded.problems)
  const mocks = parseMocks(loaded.value.graph, args.mocks)
  if (!(mocks instanceof Map)) return refused([mocks])
  const input = parseInputs(loaded.value.graph, args.inputs, args.inputJson)
  if (!input.ok) return refused([input.problem])
  const result = await dryRun(loaded.value, input.input, mocks)
  if (!result.ok) return refused(result.problems)
  if (args.json) return json({ ok: true, status: result.status, steps: result.steps })
  const lines: string[] = []
  result.steps.forEach((step, i) => {
    const error = step.error ? `  ${step.error.name}: ${step.error.message}` : ''
    lines.push(`${i + 1}. ${step.node}  ${step.status}${error}`)
    for (const c of step.conditions) lines.push(`   ${c.if} -> ${c.to}: ${c.value}`)
    lines.push(`   state: ${JSON.stringify(step.state)}`)
  })
  lines.push(`status: ${result.status}`, 'dry run: nothing was started, asked, sent or written')
  return { exitCode: result.status === 'done' ? 0 : 1, stdout: `${lines.join('\n')}\n` }
}
