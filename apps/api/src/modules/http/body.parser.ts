import { JsonParser, JsonParserOptions, ServerKitBodyParser, ServerKitParserMappings } from '@maroonedsoftware/koa';
import type { InjectKitRegistry } from 'injectkit';

/**
 * Register the ServerKit request-body parsing graph for JSON.
 *
 * {@link bodyParserMiddleware} resolves a {@link ServerKitBodyParser} from the
 * request-scoped container; that parser selects a {@link JsonParser} by
 * `Content-Type` via the {@link ServerKitParserMappings} map. The auth API only
 * speaks JSON, so only the JSON parsers are mapped here — add `urlencoded` /
 * `text` / `multipart` (see `defaultParserMappings`) if other media types are
 * introduced.
 */
export function registerBodyParser(registry: InjectKitRegistry): void {
    registry.register(JsonParserOptions).useClass(JsonParserOptions).asSingleton();
    registry.register(JsonParser).useClass(JsonParser).asSingleton();
    registry
        .register(ServerKitParserMappings)
        .useMap(ServerKitParserMappings)
        .set('json', JsonParser)
        .set('application/*+json', JsonParser);
    registry.register(ServerKitBodyParser).useClass(ServerKitBodyParser).asSingleton();
}
