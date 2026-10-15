import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadGraphText } from '../format/graphFile.ts'
import { settle, testEnv } from './fakeHost.ts'
import { FileJournalStore, JOURNAL_FILE } from './fileStore.ts'
import { JournalError, type JournalStore, MemoryJournalStore, type RunKey } from './journal.ts'
import { journalStoreFailures } from './storeSuite.ts'

const ROUTER = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: router }
edges: []
`

function fileStore() {
  const roots = new Map<JournalStore, string>()
  const make = () => {
    const root = mkdtempSync(join(tmpdir(), 'wire-store-'))
    const store = new FileJournalStore(root)
    roots.set(store, root)
    return store
  }
  const journal = (store: JournalStore, key: RunKey) =>
    join(roots.get(store) as string, key.scope, key.graph, key.runId, JOURNAL_FILE)
  return {
    make,
    tear: (store: JournalStore, key: RunKey) => {
      const path = journal(store, key)
      const text = readFileSync(path, 'utf8')
      writeFileSync(path, text.slice(0, text.length - 7))
      const reopened = new FileJournalStore(roots.get(store) as string)
      roots.set(reopened, roots.get(store) as string)
      return reopened
    },
    break: (store: JournalStore, key: RunKey) => chmodSync(journal(store, key), 0o400),
  }
}

describe('journal stores', () => {
  it('GRF-C206 the async file store and the memory store pass the same store contract', async () => {
    const files = fileStore()
    expect(await journalStoreFailures(files.make, files)).toEqual([])
    expect(await journalStoreFailures(() => new MemoryJournalStore())).toEqual([])
  })

  it('GRF-C206 a started run is in the store when start answers, and a store that cannot create answers journal-failed', async () => {
    const env = testEnv()
    const loaded = loadGraphText(ROUTER, '/w/.ostia/graphs/g.yaml')
    if (!loaded.ok) throw new Error('graph')
    const def = { name: 'g', graph: loaded.value.graph, fingerprint: loaded.value.fingerprint }
    const res = await env.engine.start('w1', def, {}, {})
    expect(res.ok).toBe(true)
    expect((await env.engine.summaries('w1')).length).toBe(1)
    await settle()

    const failing = new MemoryJournalStore()
    failing.create = async () => {
      throw new JournalError('journal-failed', 'disk full')
    }
    const broken = testEnv({ store: failing })
    expect(await broken.engine.start('w1', def, {}, {})).toEqual({
      ok: false,
      error: 'journal-failed',
      message: 'disk full',
    })
    expect(broken.engine.active('w1')).toEqual([])
  })
})
