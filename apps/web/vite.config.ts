import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During `vite dev`, proxy the API to the locally-running Koa server so the SPA
// is same-origin in development too (matching production, where the API serves
// the built bundle). Override the target with VITE_API_TARGET if needed.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/icloud': { target: apiTarget, changeOrigin: true },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
});
