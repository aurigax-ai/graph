import type { KindDescriptor } from '../engine/contract'
import { agentKind } from './agent'
import { commandKind } from './command'
import { approvalKind, connectorKind } from './humanKinds'
import { notifyKind, routerKind, waitKind } from './smallKinds'

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
