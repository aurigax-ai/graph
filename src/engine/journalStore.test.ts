import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileJournalStore } from './fileStore.ts'
import { MemoryJournalStore } from './journal.ts'
import { journalStoreFailures } from './storeSuite.ts'

describe('journal stores', () => {
  it('GRF-C206 the async file store and the memory store pass the same store contract', async () => {
    expect(
      await journalStoreFailures(
        () => new FileJournalStore(mkdtempSync(join(tmpdir(), 'wire-store-'))),
      ),
    ).toEqual([])
    expect(await journalStoreFailures(() => new MemoryJournalStore())).toEqual([])
  })
})
