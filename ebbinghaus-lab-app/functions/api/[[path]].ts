import { handle } from 'hono/cloudflare-pages';
import { honoApp } from '../../src/index';

export const onRequest = handle(honoApp);
