import {
  constants,
  type Dirent,
  type FSWatcher,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  watch,
} from 'node:fs'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'

const WATCH_FOLDERS_MAX = 5000
const ALWAYS_IGNORED = new Set(['.git', 'node_modules'])
const RULES_MAX_BYTES = 64 * 1024

export type WatchStart = { ok: true; folders: number } | { ok: false; reason: 'too-many-folders' }

function parentOf(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? '' : rel.slice(0, cut)
}

function readRules(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const buffer = Buffer.alloc(RULES_MAX_BYTES)
    const read = readSync(fd, buffer, 0, RULES_MAX_BYTES, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    return read < RULES_MAX_BYTES ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function entries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export class FolderWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly rules = new Map<string, Ignore>()

  constructor(
    private readonly root: string,
    private readonly onPath: (rel: string) => void,
    private readonly onRefused: () => void,
    private readonly max = WATCH_FOLDERS_MAX,
  ) {}

  start(): WatchStart {
    const folders = this.scan('', [])
    if (!folders) {
      this.rules.clear()
      return { ok: false, reason: 'too-many-folders' }
    }
    for (const dir of folders) this.watchDir(dir)
    return { ok: true, folders: folders.length }
  }

  watching(): number {
    return this.watchers.size
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.rules.clear()
  }

  ignored(rel: string, isDir: boolean): boolean {
    const parts = rel.split('/')
    if (parts.some((part) => ALWAYS_IGNORED.has(part))) return true
    for (let i = 0; i < parts.length; i++) {
      const base = parts.slice(0, i).join('/')
      const rule = this.rules.get(base)
      if (!rule) continue
      const below = parts.slice(i).join('/')
      if (rule.ignores(isDir ? `${below}/` : below)) return true
    }
    return false
  }

  private loadRules(dir: string): void {
    const text = readRules(join(this.root, dir, '.gitignore'))
    if (text === null) this.rules.delete(dir)
    else this.rules.set(dir, ignore().add(text))
  }

  private scan(dir: string, out: string[]): string[] | null {
    this.loadRules(dir)
    out.push(dir)
    if (out.length > this.max) return null
    for (const entry of entries(join(this.root, dir))) {
      if (!entry.isDirectory()) continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (this.ignored(rel, true)) continue
      if (!this.scan(rel, out)) return null
    }
    return out
  }

  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return
    let watcher: FSWatcher
    try {
      watcher = watch(join(this.root, dir), (_event, name) => {
        if (typeof name !== 'string' || name.length === 0) return
        this.changed(dir ? `${dir}/${name}` : name)
      })
    } catch {
      return
    }
    watcher.on('error', () => {
      watcher.close()
      this.watchers.delete(dir)
    })
    this.watchers.set(dir, watcher)
  }

  private forget(rel: string): boolean {
    let found = false
    for (const [dir, watcher] of [...this.watchers]) {
      if (dir !== rel && !dir.startsWith(`${rel}/`)) continue
      watcher.close()
      this.watchers.delete(dir)
      this.rules.delete(dir)
      found = true
    }
    return found
  }

  private changed(rel: string): void {
    let isDir = false
    try {
      const info = lstatSync(join(this.root, rel))
      if (info.isSymbolicLink()) return
      isDir = info.isDirectory()
    } catch {
      if (this.forget(rel)) return
    }
    if (rel.endsWith('.gitignore') && !isDir) this.loadRules(parentOf(rel))
    if (this.ignored(rel, isDir)) return
    if (isDir && !this.watchers.has(rel)) {
      const added = this.scan(rel, [])
      if (!added || this.watchers.size + added.length > this.max) {
        this.stop()
        this.onRefused()
        return
      }
      for (const dir of added) this.watchDir(dir)
      return
    }
    if (!isDir) this.onPath(rel)
  }
}
