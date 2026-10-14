import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKED_GRAPHS, type WorkedGraph, workedGraph } from '../engine/fixtures.ts'
import { main } from './main.ts'

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-'))
  mkdirSync(join(dir, '.ostia/graphs'), { recursive: true })
  for (const name of WORKED_GRAPHS)
    writeFileSync(join(dir, `.ostia/graphs/${name}.yaml`), workedGraph(name))
  return dir
}

const file = (name: WorkedGraph | string) => `.ostia/graphs/${name}.yaml`

describe('the headless wire commands', () => {
  it('GRF-C10 validate prints ok, the name and the counts', async () => {
    const dir = workspace()
    const out = await main(['validate', file('review-loop')], dir)
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, name: 'review-loop', nodes: 8, edges: 6 })
  })

  it('GRF-C173 a dry run of the review loop follows the mocks and makes nothing', async () => {
    const dir = workspace()
    const out = await main(
      [
        'dry-run',
        file('review-loop'),
        '--input',
        'task=fix the flaky test',
        '--mock',
        'implement={"outcome":"stopped","result":{"summary":"done"}}',
        '--mock',
        'fix={"outcome":"stopped","result":{"summary":"fixed"}}',
        '--mock',
        'review={"outcome":"stopped","result":{"verdict":"fail","findings":["a bug"]}}',
        '--mock',
        'review={"outcome":"stopped","result":{"verdict":"pass","findings":[]}}',
        '--json',
      ],
      dir,
    )
    const result = JSON.parse(out.stdout) as {
      status: string
      steps: {
        node: string
        conditions: { if: string; value: boolean }[]
        state: Record<string, unknown>
      }[]
    }
    expect(result.steps.map((s) => s.node)).toEqual([
      'implement',
      'test',
      'review',
      'verdict',
      'fix',
      'test',
      'review',
      'verdict',
      'ask',
      'open-pr',
    ])
    expect(result.steps[3].conditions).toEqual([
      { if: "state.verdict == 'pass'", value: false, to: 'ask' },
      { if: 'run.visits.fix >= 3', value: false, to: 'gave-up' },
    ])
    expect(result.steps[2].state).toMatchObject({ verdict: 'fail', findings: ['a bug'] })
    expect(result.status).toBe('done')
    const text = await main(['dry-run', file('review-loop'), '--input', 'task=t'], dir)
    expect(text.stdout).toContain('nothing was started, asked, sent or written')
    expect(existsSync(join(dir, '.wire'))).toBe(false)
  })

  it('GRF-C174 explain outlines the daily report and a dry run without mocks reports NoResult at the agent', async () => {
    const dir = workspace()
    const out = await main(['explain', file('daily-report')], dir)
    expect(out.stdout).toContain('schedule {"cron":"0 9 * * 1-5","catchUp":true}')
    expect(out.stdout).toContain('start: pulls, issues (fan-out)')
    expect(out.stdout).toContain('[pulls, issues] -> write  (join)')
    expect(out.stdout).toContain('  write  agent (agent)')
    expect(out.stdout).toContain('  pulls  connector (external)')
    expect(out.stdout).toContain('kinds needed: connector, agent, notify')
    expect(out.stdout).toContain(
      'connectors needed: mcp:tracker/list_pull_requests, mcp:tracker/list_issues',
    )
    const dry = JSON.parse(
      (await main(['dry-run', file('daily-report'), '--json'], dir)).stdout,
    ) as {
      status: string
      steps: { node: string; error?: { name: string } }[]
    }
    expect(dry.steps.find((s) => s.node === 'write')?.error?.name).toBe('NoResult')
    expect(dry.status).toBe('failed')
  })

  it('GRF-C161 explain lists agent among the kinds a graph needs', async () => {
    const dir = workspace()
    expect((await main(['explain', file('review-loop')], dir)).stdout).toContain(
      'kinds needed: agent, command, router, approval, notify',
    )
    const run = await main(['run', file('review-loop'), '--input', 'task=t'], dir)
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('unsupported-kind: agent (host: headless)')
  })

  it('GRF-C187 a dry run of a bad file, an unknown mock node or a mock of the wrong shape makes nothing', async () => {
    const dir = workspace()
    writeFileSync(join(dir, file('broken')), 'version: 1\nstart: a\n')
    const bad = await main(['dry-run', file('broken')], dir)
    expect(bad.exitCode).toBe(1)
    expect(JSON.parse(bad.stdout).ok).toBe(false)
    const unknown = await main(
      ['dry-run', file('review-loop'), '--input', 'task=t', '--mock', 'nope={}'],
      dir,
    )
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stdout).toContain('unknown-node: nope')
    const shape = JSON.parse(
      (
        await main(
          [
            'dry-run',
            file('review-loop'),
            '--input',
            'task=t',
            '--mock',
            'implement={"result":{"summary":"s"}}',
            '--mock',
            'test={"exit":"zero"}',
            '--json',
          ],
          dir,
        )
      ).stdout,
    ) as { steps: { node: string; error?: { name: string } }[] }
    expect(shape.steps.find((s) => s.node === 'test')?.error?.name).toBe('BadOutput')
    expect(existsSync(join(dir, '.wire'))).toBe(false)
  })
})
