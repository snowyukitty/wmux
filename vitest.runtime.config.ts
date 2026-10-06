import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.runtime.test.{ts,tsx}',
      'scripts/__tests__/**/*.runtime.test.mjs',
      'integrations/**/__tests__/**/*.runtime.test.{ts,tsx}',
    ],
    environment: 'node',
    fileParallelism: false,
    // Same temp HOME + data suffix as the parallel lane: runtime tests spawn real
    // sessions whose shell integration writes under the wmux data dir.
    setupFiles: ['./src/test-utils/isolateDataDir.ts'],
  },
});
