import { loadGraphText } from '../format/graphFile'
import { CONTRACT_VERSION } from '../format/model'
import { descriptorOf } from '../kinds/catalog'
import type { Host, Notice } from './contract'
import { Engine } from './engine'
import { MemoryJournalStore } from './journal'
import { isEnded } from './runState'

const PROBE = (command: string[]) => `version: 1
on: [{ manual: {} }]
start: route
state:
  exit: { type: integer, default: -1 }
nodes:
  - { id: route, kind: router }
  - { id: cmd, kind: command, with: { run: ${JSON.stringify(command)} }, out: { exit: exit } }
  - { id: tell, kind: notify, with: { title: "probe {{state.exit}}" } }
edges:
  - { from: route, to: cmd }
  - { from: cmd, to: tell }
`

export interface ContractProbe {
  host: Host
  notices: Notice[]
  command: string[]
  expectedExit: number
  wait?: () => Promise<void>
}

export async function contractFailures(probe: ContractProbe): Promise<string[]> {
  const failures: string[] = []
  const { host } = probe
  if (host.contract !== CONTRACT_VERSION)
    failures.push(`contract ${host.contract} is not ${CONTRACT_VERSION}`)
  if (!host.triggers.includes('manual')) failures.push('the host has no manual trigger')
  for (const kind of host.kinds) {
    const descriptor = descriptorOf(kind.kind)
    if (!descriptor) failures.push(`${kind.kind} is not a node kind of the format`)
    else if (descriptor.version !== kind.version)
      failures.push(`${kind.kind}@${kind.version} is not @${descriptor.version}`)
  }
  for (const needed of ['router', 'command', 'notify', 'wait']) {
    if (!host.kinds.some((k) => k.kind === needed))
      failures.push(`the host lacks the generic kind ${needed}`)
  }
  const loaded = loadGraphText(PROBE(probe.command), '/probe/.ostia/graphs/probe.yaml')
  if (!loaded.ok) return [...failures, 'the probe graph does not validate']
  const engine = new Engine({ host, store: new MemoryJournalStore() })
  const res = engine.start(
    'probe',
    { name: 'probe', graph: loaded.value.graph, fingerprint: loaded.value.fingerprint },
    {},
    {},
  )
  if (!res.ok || !('runId' in res))
    return [...failures, `the probe did not start: ${JSON.stringify(res)}`]
  const run = engine.run(res.runId)
  for (let i = 0; i < 200 && run && !isEnded(run.state.status); i++) {
    await (probe.wait ? probe.wait() : new Promise((r) => setTimeout(r, 10)))
  }
  if (run?.state.status !== 'done') failures.push(`the probe ended ${run?.state.status}`)
  if (run?.state.state.exit !== probe.expectedExit)
    failures.push(`the command's exit is ${String(run?.state.state.exit)}`)
  if (!probe.notices.some((n) => n.title === `probe ${probe.expectedExit}`))
    failures.push('the notify kind sent nothing')
  return failures
}
