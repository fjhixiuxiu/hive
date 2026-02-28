import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'] },
  },
});
