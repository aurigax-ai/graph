import type { Clock } from '../engine/contract.ts'

export const PATH_BATCH_MS = 1000

export class PathBatch {
  private paths = new Set<string>()
  private cancel: (() => void) | null = null

  constructor(
    private readonly clock: Clock,
    private readonly flush: (paths: string[]) => void,
    private readonly windowMs = PATH_BATCH_MS,
  ) {}

  add(path: string): void {
    this.paths.add(path)
    if (this.cancel) return
    this.cancel = this.clock.setTimer(this.clock.now() + this.windowMs, () => {
      this.cancel = null
      const paths = [...this.paths].sort()
      this.paths.clear()
      if (paths.length > 0) this.flush(paths)
    })
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
    this.paths.clear()
  }
}
