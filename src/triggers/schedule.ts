import { Cron } from 'croner'
import { parseDuration } from '../format/duration.ts'
import type { ScheduleTrigger } from '../format/model.ts'

const CRON_FIELDS = 5

export type Schedule = ScheduleTrigger['schedule']

export function cronValid(value: string): boolean {
  if (value.trim().split(/\s+/).length !== CRON_FIELDS) return false
  try {
    new Cron(value, { paused: true })
    return true
  } catch {
    return false
  }
}

export function nextScheduled(
  schedule: Schedule,
  after: number,
  anchor: number,
  timezone?: string,
): number | null {
  if (schedule.every !== undefined) {
    const every = parseDuration(schedule.every)
    if (!every) return null
    const steps = Math.floor((after - anchor) / every) + 1
    return anchor + Math.max(1, steps) * every
  }
  if (schedule.cron === undefined) return null
  const cron = new Cron(schedule.cron, { paused: true, ...(timezone ? { timezone } : {}) })
  return cron.nextRun(new Date(after))?.getTime() ?? null
}
