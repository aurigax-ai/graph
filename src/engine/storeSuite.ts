import { JOURNAL_VERSION } from '../format/model.ts'
import {
  JOURNAL_LINE_MAX,
  JournalError,
  type JournalStore,
  type Line,
  type RunKey,
} from './journal.ts'

const KEY_A: RunKey = { scope: 'suite', graph: 'g', runId: '20261015T120000Z-aaaa' }
const KEY_B: RunKey = { scope: 'suite', graph: 'g', runId: '20261015T120001Z-bbbb' }
const KEY_OTHER: RunKey = { scope: 'elsewhere', graph: 'h', runId: '20261015T120002Z-cccc' }

function line(seq: number): Line {
  return { v: JOURNAL_VERSION, seq, t: 1_000 + seq, type: 'run-pause' }
}

function isPromise(value: unknown): boolean {
  return value instanceof Promise
}

async function rejectsWith(fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof JournalError && err.code === code
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

export interface StoreHooks {
  tear?: (store: JournalStore, key: RunKey) => JournalStore | Promise<JournalStore>
  break?: (store: JournalStore, key: RunKey) => void | Promise<void>
}

export async function journalStoreFailures(
  make: () => JournalStore,
  hooks: StoreHooks = {},
): Promise<string[]> {
  const failures: string[] = []
  const store = make()
  const calls: [string, () => unknown][] = [
    ['create', () => store.create(KEY_A, { name: 'g' })],
    ['append', () => store.append(KEY_A, line(1))],
    ['read', () => store.read(KEY_A)],
    ['list', () => store.list()],
    ['remove', () => store.remove({ ...KEY_A, runId: '20261015T115959Z-dddd' })],
  ]
  for (const [name, call] of calls) {
    const result = call()
    if (!isPromise(result)) failures.push(`${name} does not return a promise`)
    await Promise.resolve(result).catch(() => {})
  }

  const fresh = make()
  await fresh.create(KEY_A, { name: 'g', n: 1 })
  const created = await fresh.read(KEY_A)
  if (!created) failures.push('a created run reads as null')
  else {
    if (JSON.stringify(created.definition) !== JSON.stringify({ name: 'g', n: 1 }))
      failures.push('a created run does not read back its definition')
    if (created.lines.length !== 0) failures.push('a created run does not start with no lines')
  }

  await fresh.append(KEY_A, line(1))
  await fresh.append(KEY_A, line(2))
  await fresh.append(KEY_A, line(3))
  const appended = await fresh.read(KEY_A)
  if (appended?.lines.map((l) => l.seq).join(',') !== '1,2,3')
    failures.push('appended lines do not read back in order')

  appended?.lines.splice(0)
  if ((await fresh.read(KEY_A))?.lines.length !== 3)
    failures.push('changing what read returned changes the store')

  if (await fresh.read(KEY_B)) failures.push('a run never created does not read as null')
  if (!(await rejectsWith(() => fresh.append(KEY_B, line(1)), 'journal-failed')))
    failures.push('an append to a run never created does not fail journal-failed')
  if (!(await rejects(() => fresh.create(KEY_A, { name: 'g' }))))
    failures.push('creating a run twice does not fail')

  await fresh.create(KEY_B, { name: 'g' })
  await fresh.create(KEY_OTHER, { name: 'h' })
  const ids = (keys: RunKey[]) => keys.map((k) => k.runId).join(',')
  if (ids(await fresh.list('suite')) !== `${KEY_A.runId},${KEY_B.runId}`)
    failures.push('list of a scope does not give its runs sorted by run id')
  if (ids(await fresh.list()) !== `${KEY_A.runId},${KEY_B.runId},${KEY_OTHER.runId}`)
    failures.push('list of every scope does not give every run sorted by run id')
  if ((await fresh.list('nobody')).length !== 0)
    failures.push('list of an unknown scope is not empty')

  await fresh.remove(KEY_A)
  if (await fresh.read(KEY_A)) failures.push('a removed run still reads')
  if ((await fresh.list('suite')).some((k) => k.runId === KEY_A.runId))
    failures.push('a removed run is still listed')
  if ((await fresh.read(KEY_B))?.lines.length !== 0)
    failures.push('removing one run changes another')

  const flight = make()
  await flight.create(KEY_A, { name: 'g' })
  await Promise.all(Array.from({ length: 20 }, (_, i) => flight.append(KEY_A, line(i + 1))))
  const flown = (await flight.read(KEY_A))?.lines.map((l) => l.seq) ?? []
  if (flown.join(',') !== Array.from({ length: 20 }, (_, i) => i + 1).join(','))
    failures.push('appends in flight together do not read back in the order they were made')

  const full = make()
  await full.create(KEY_A, { name: 'g' })
  const huge = { ...line(1), state: { text: 'x'.repeat(JOURNAL_LINE_MAX) } } as Line
  if (!(await rejectsWith(() => full.append(KEY_A, huge), 'journal-full')))
    failures.push('a line over 512 KiB does not fail journal-full')
  if ((await full.read(KEY_A))?.lines.length !== 0)
    failures.push('a line refused as journal-full is still kept')

  if (hooks.tear) {
    const torn = make()
    await torn.create(KEY_A, { name: 'g' })
    await torn.append(KEY_A, line(1))
    await torn.append(KEY_A, line(2))
    const reopened = await hooks.tear(torn, KEY_A)
    if ((await reopened.read(KEY_A))?.lines.map((l) => l.seq).join(',') !== '1')
      failures.push('a torn last line is not dropped')
    await reopened.append(KEY_A, line(2))
    await reopened.append(KEY_A, line(3))
    if ((await reopened.read(KEY_A))?.lines.map((l) => l.seq).join(',') !== '1,2,3')
      failures.push('lines appended after a torn last line are lost')
  }

  if (hooks.break) {
    const broken = make()
    await broken.create(KEY_A, { name: 'g' })
    await hooks.break(broken, KEY_A)
    if (!(await rejectsWith(() => broken.append(KEY_A, line(1)), 'journal-failed')))
      failures.push('an append the store cannot write does not fail journal-failed')
  }
  return failures
}
