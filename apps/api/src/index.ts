import 'reflect-metadata';
import { Logger } from '@maroonedsoftware/logger';
import { startApiServer } from './modules/http/index.js';

const api = await startApiServer();
api.container.get(Logger).info(`API listening on :${api.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
        void api.stop();
    });
}
