import { defineConfig } from 'vitest/config';

// Extension production files are plain service-worker / IIFE / MAIN-world
// scripts (not ES modules), so the tests load them into a Node `vm` context
// with the appropriate global shims (`self`, `window`, `chrome`, ...). A node
// environment is therefore all we need.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
