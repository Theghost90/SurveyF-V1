import { env } from '../config/env';

/** Per-route rate limit. Relaxed 1000x under NODE_ENV=test so integration tests can register many users. */
export const rl = (max: number, timeWindow = '1 minute') => ({
  config: { rateLimit: { max: env.NODE_ENV === 'test' ? max * 1000 : max, timeWindow } },
});
