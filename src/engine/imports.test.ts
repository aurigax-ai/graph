import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const PACKAGE = resolve(ROOT, '..')
const IMPORT =
  /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g
const ALLOWED_PACKAGES = ['yaml', 'zod', 'vitest', 'ajv', '@marcbachmann/cel-js']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('the engine package stands alone', () => {
  it('GRF-C180 no import names electron, src/, the extension SDK or a path outside graph-engine/', () => {
    const bad: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(IMPORT)) {
        const spec = (match[1] ?? match[2] ?? match[3]) as string
        const where = `${relative(PACKAGE, file)}: ${spec}`
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          if (relative(PACKAGE, target).startsWith('..')) bad.push(where)
        } else if (
          !spec.startsWith('node:') &&
          !ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))
        ) {
          bad.push(where)
        }
      }
    }
    expect(bad).toEqual([])
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['yaml', 'zod'])
  })
})
