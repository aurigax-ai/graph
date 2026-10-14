import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Notice } from '../engine/contract'
import { contractFailures } from '../engine/contractSuite'
import { headlessHost } from './headlessHost'

describe('the headless host', () => {
  it('GRF-C6 passes the host contract suite', async () => {
    const notices: Notice[] = []
    const host = headlessHost({ cwd: tmpdir(), log: (n) => notices.push(n) })
    const failures = await contractFailures({
      host,
      notices,
      command: [process.execPath, '-e', 'process.exit(3)'],
      expectedExit: 3,
    })
    expect(failures).toEqual([])
  })
})
