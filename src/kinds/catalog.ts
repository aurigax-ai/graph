import type { KindDescriptor } from '../engine/contract.ts'
import { agentKind } from './agent.ts'
import { commandKind } from './command.ts'
import { approvalKind, connectorKind } from './humanKinds.ts'
import { notifyKind, routerKind, waitKind } from './smallKinds.ts'

export const FORMAT_KINDS: readonly KindDescriptor[] = [
  agentKind,
  commandKind,
  routerKind,
  approvalKind,
  waitKind,
  notifyKind,
  connectorKind,
]

export const KIND_NAMES = FORMAT_KINDS.map((k) => k.kind)

export function descriptorOf(kind: string): KindDescriptor | undefined {
  return FORMAT_KINDS.find((k) => k.kind === kind)
}
