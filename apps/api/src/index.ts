import 'reflect-metadata';
import { Logger } from '@maroonedsoftware/logger';
import { loadAppConfig } from './modules/config/app.config.js';
import { buildLogger, installGlobalErrorHandlers, LogConfig } from './modules/logging/index.js';
import { startApiServer } from './modules/http/index.js';

// Build the logger and install crash handlers *before* startup so that even a
// failure while booting (bad config, DB unreachable) is written to the rotating
// log rather than lost to stderr. The same instance is handed to the server so
// the whole app shares one logger.
const appConfig = await loadAppConfig();
const logger = buildLogger(LogConfig.fromAppConfig(appConfig));

let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
installGlobalErrorHandlers(logger, { onFatal: () => api?.stop() });

try {
    api = await startApiServer({ appConfig, logger });
    api.container.get(Logger).info(`API listening on :${api.port}`);
} catch (error) {
    logger.error('API failed to start', error);
    process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
        void api?.stop();
    });
}
