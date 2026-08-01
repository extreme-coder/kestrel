import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The annealing worker and SSE tests drive fake timers; keep them serial so a
    // shared in-memory database is never touched by two suites at once.
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
  },
})
