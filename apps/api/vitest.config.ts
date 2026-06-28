import { defineProject } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineProject({
    oxc: false,
    test: {
        globals: true,
        include: ['./tests/**/*.test.ts'],
        setupFiles: './tests/_helpers/setup.ts',
        globalSetup: './tests/_helpers/setup.global.ts',
        environment: 'node',
        testTimeout: 50000,
        hookTimeout: 30000,
        fileParallelism: true,
        pool: 'forks',
        isolate: false,
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            '#routes': new URL('./src/routes/', import.meta.url).pathname,
            '#modules': new URL('./src/modules/', import.meta.url).pathname,
            '#shared': new URL('./src/shared/', import.meta.url).pathname,
            '#vendors': new URL('./src/vendors/', import.meta.url).pathname,
            '#tests': new URL('./tests/', import.meta.url).pathname,
            '#helpers': new URL('./tests/_helpers/', import.meta.url).pathname,
        },
    },
    plugins: [swc.vite()],
});
