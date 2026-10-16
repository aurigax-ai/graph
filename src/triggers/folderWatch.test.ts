import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hasMkfifo = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
import { FolderWatcher } from './folderWatch.ts'

const roots: string[] = []
const watchers: FolderWatcher[] = []

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'wire-watch-'))
  roots.push(root)
  for (const dir of ['src/a', '.git/objects', 'node_modules/x', 'build/out']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n')
  return root
}

const POLL = { timeout: 2000, interval: 10 }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function observe(root: string) {
  const seen: string[] = []
  const probes: string[] = []
  let next = 0
  const onPath = (rel: string): void => {
    if (rel.split('/').at(-1)?.startsWith('.probe-')) probes.push(rel)
    else seen.push(rel)
  }
  const armed = async (...dirs: string[]): Promise<void> => {
    for (const dir of dirs) {
      const wrote: string[] = []
      for (let i = 0; i < 200 && !wrote.some((probe) => probes.includes(probe)); i++) {
        const probe = dir ? `${dir}/.probe-${next}` : `.probe-${next}`
        next += 1
        wrote.push(probe)
        writeFileSync(join(root, probe), '1')
        await sleep(10)
      }
      expect(probes.filter((probe) => wrote.includes(probe))).not.toEqual([])
    }
    seen.length = 0
  }
  return { seen, onPath, armed }
}

describe('the folder watcher of a files trigger', () => {
  it('reports changes outside .git, node_modules and gitignored paths', async () => {
    const root = folder()
    const { seen, onPath, armed } = observe(root)
    const watcher = new FolderWatcher(root, onPath, () => {})
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 3 })
    await armed('', 'src', 'src/a')
    writeFileSync(join(root, 'node_modules/x/i.js'), '1')
    writeFileSync(join(root, '.git/objects/o'), '1')
    writeFileSync(join(root, 'build/out/b.ts'), '1')
    writeFileSync(join(root, 'src/a/debug.log'), '1')
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await vi.waitUntil(() => seen.includes('src/a/b.ts'), POLL)
    await sleep(100)
    expect([...new Set(seen)]).toEqual(['src/a/b.ts'])
  })

  it('watches a folder made after it started', async () => {
    const root = folder()
    const { seen, onPath, armed } = observe(root)
    const watcher = new FolderWatcher(root, onPath, () => {})
    watchers.push(watcher)
    watcher.start()
    await armed('', 'src', 'src/a')
    mkdirSync(join(root, 'src/new'))
    await vi.waitUntil(() => watcher.watching() === 4, POLL)
    await armed('src/new')
    writeFileSync(join(root, 'src/new/c.ts'), '1')
    await vi.waitUntil(() => seen.includes('src/new/c.ts'), POLL)
    expect(seen).toContain('src/new/c.ts')
  })

  it('refuses a folder with more folders than it may watch', () => {
    const root = folder()
    for (let i = 0; i < 6; i++) mkdirSync(join(root, `src/d${i}`))
    const watcher = new FolderWatcher(
      root,
      () => {},
      () => {},
      5,
    )
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: false, reason: 'too-many-folders' })
  })

  it('never follows a link to a folder outside the workspace, made before or after it started', async () => {
    const root = folder()
    const outside = mkdtempSync(join(tmpdir(), 'graphs-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'src/before'))
    const { seen, onPath, armed } = observe(root)
    const watcher = new FolderWatcher(root, onPath, () => {})
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 3 })
    await armed('', 'src', 'src/a')
    symlinkSync(outside, join(root, 'src/after'))
    await sleep(150)
    writeFileSync(join(outside, 'secret.ts'), '1')
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await vi.waitUntil(() => seen.includes('src/a/b.ts'), POLL)
    await sleep(150)
    expect(seen.filter((p) => p.startsWith('src/before') || p.startsWith('src/after'))).toEqual([])
    expect(watcher.watching()).toBe(3)
  })

  it('reads no .gitignore that is a link, so rules from a file outside are never applied', async () => {
    const root = folder()
    const outside = mkdtempSync(join(tmpdir(), 'graphs-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'rules'), 'src/\n')
    rmSync(join(root, '.gitignore'))
    symlinkSync(join(outside, 'rules'), join(root, '.gitignore'))
    const { seen, onPath, armed } = observe(root)
    const watcher = new FolderWatcher(root, onPath, () => {})
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 5 })
    expect(watcher.ignored('src/a/b.ts', false)).toBe(false)
    await armed('src/a')
    writeFileSync(join(root, 'src/a/b.ts'), '1')
    await vi.waitUntil(() => seen.includes('src/a/b.ts'), POLL)
    expect(seen).toContain('src/a/b.ts')
  })

  it.skipIf(!hasMkfifo)('never blocks on a .gitignore that is a fifo', () => {
    const root = folder()
    rmSync(join(root, '.gitignore'))
    execFileSync('mkfifo', [join(root, '.gitignore')])
    const watcher = new FolderWatcher(
      root,
      () => {},
      () => {},
    )
    watchers.push(watcher)
    const started = Date.now()
    expect(watcher.start()).toEqual({ ok: true, folders: 5 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(watcher.ignored('build/out/b.ts', false)).toBe(false)
  })

  it('drops the watchers of a removed folder and watches it again when it comes back', async () => {
    const root = folder()
    mkdirSync(join(root, 'src/a/deep'))
    const { seen, onPath, armed } = observe(root)
    const watcher = new FolderWatcher(root, onPath, () => {})
    watchers.push(watcher)
    expect(watcher.start()).toEqual({ ok: true, folders: 4 })
    await armed('', 'src', 'src/a', 'src/a/deep')
    rmSync(join(root, 'src/a'), { recursive: true, force: true })
    await vi.waitUntil(() => watcher.watching() === 2, POLL)
    expect(watcher.watching()).toBe(2)
    mkdirSync(join(root, 'src/a'))
    await vi.waitUntil(() => watcher.watching() === 3, POLL)
    await armed('src/a')
    writeFileSync(join(root, 'src/a/c.ts'), '1')
    await vi.waitUntil(() => seen.includes('src/a/c.ts'), POLL)
    expect(seen).toContain('src/a/c.ts')
    expect(watcher.watching()).toBe(3)
  })
})
