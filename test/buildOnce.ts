import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export default function setup(): void {
  const root = join(import.meta.dirname, '..')
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
    cwd: root,
    stdio: 'inherit',
  })
}
