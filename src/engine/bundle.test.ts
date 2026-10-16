import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

function readsAtLoad(file: string): number[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines: number[] = []
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nested = inFunction || ts.isFunctionLike(node)
    if (!nested && ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    ts.forEachChild(node, (child) => visit(child, nested))
  }
  visit(source, false)
  return lines
}

describe('the package bundles', () => {
  it('GRF-C180 no module the package root exports reads import.meta while it loads, so a host can bundle it', () => {
    const found = sources(ROOT)
      .filter((f) => !/[/\\](testing|engine[/\\]fixtures)\.ts$/.test(f))
      .flatMap((f) => readsAtLoad(f).map((line) => `${relative(ROOT, f)}:${line}`))
    expect(found).toEqual([])
  })
})
