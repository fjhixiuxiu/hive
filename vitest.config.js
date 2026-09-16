import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.js'],
    // Owns the .hive-setup.json sentinel for the whole run so parallel suites
    // that boot the web server can't delete it out from under each other.
    globalSetup: ['test/helpers/global-setup.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'] },
  },
});
