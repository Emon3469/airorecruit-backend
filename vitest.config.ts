import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    env: { NODE_ENV: 'test', LLM_PROVIDER: 'mock', LLM_API_KEY: '', SERPER_API_KEY: '', OUTREACH_DAY_MS: '60000', TALENT_MIN_SIMILARITY: '0.2' },
    pool: 'forks',
    fileParallelism: false,
  },
});
