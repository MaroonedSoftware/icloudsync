import { defineConfig } from 'vitest/config';

// The web tests cover pure presentation/client logic (formatting helpers and the
// typed API client), so a plain Node environment is enough — no jsdom or React
// renderer required.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['./tests/**/*.test.ts'],
    },
});
