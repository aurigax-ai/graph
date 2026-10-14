import picomatch from 'picomatch'
import type { Output } from '../engine/contract.ts'
import type { GraphFile, Trigger } from '../format/model.ts'
import { triggerKind } from '../format/model.ts'

export type AgentState = 'stopped' | 'waiting'

export type TriggerEvent =
  | { kind: 'files'; paths: string[] }
  | { kind: 'command'; pane: string; exitCode: number }
  | { kind: 'agent'; pane: string; state: AgentState; agent?: string }

function filesPayload(glob: string | string[], paths: string[]): Output | null {
  const matches = picomatch(glob, { dot: true })
  const hit = [...new Set(paths.filter((p) => matches(p)))].sort()
  return hit.length > 0 ? { kind: 'files', paths: hit } : null
}

function exitMatches(exit: 'any' | 'zero' | 'nonzero' | undefined, code: number): boolean {
  if (exit === 'zero') return code === 0
  if (exit === 'nonzero') return code !== 0
  return true
}

export function triggerPayload(trigger: Trigger, event: TriggerEvent): Output | null {
  if ('files' in trigger && event.kind === 'files') {
    return filesPayload(trigger.files.glob, event.paths)
  }
  if ('command' in trigger && event.kind === 'command') {
    if (!exitMatches(trigger.command.exit, event.exitCode)) return null
    return { kind: 'command', pane: event.pane, exit: event.exitCode }
  }
  if ('agent' in trigger && event.kind === 'agent') {
    if (trigger.agent.state !== event.state) return null
    if (trigger.agent.agent !== undefined && trigger.agent.agent !== event.agent) return null
    return {
      kind: 'agent',
      pane: event.pane,
      state: event.state,
      ...(event.agent !== undefined ? { agent: event.agent } : {}),
    }
  }
  return null
}

export function firedBy(graph: GraphFile, event: TriggerEvent): Output | null {
  for (const trigger of graph.on) {
    if (triggerKind(trigger) !== event.kind) continue
    const payload = triggerPayload(trigger, event)
    if (payload) return payload
  }
  return null
}

export function liveTriggers(graph: GraphFile): Trigger[] {
  return graph.on.filter((t) => triggerKind(t) !== 'manual')
}
