import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Counts failed verification attempts (registration codes, password-reset
 * confirmations) per key, so a code/token can be voided after too many
 * failures.
 *
 * Redis-backed when Redis is reachable (atomic INCR + expiry, shared across
 * instances), with an in-process Map fallback when Redis is unavailable —
 * the same fallback posture as the login / password-reset throttle guards.
 * A Redis outage therefore degrades to per-instance throttling instead of
 * disabling throttling entirely.
 */

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

type MemoryBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class VerificationThrottleService {
  private readonly logger = new Logger(VerificationThrottleService.name);
  private readonly redis: Redis;
  private readonly memory = new Map<string, MemoryBucket>();
  private redisAvailable = true;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(config.get<string | number>('REDIS_PORT') ?? 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Do not retry forever: a down Redis must fall back to memory fast.
      retryStrategy: () => null,
    });
    // ioredis emits 'error' on connection failures; without a listener the
    // process would crash on an unhandled 'error' event.
    this.redis.on('error', (error) => {
      if (this.redisAvailable) {
        this.logger.warn(
          `Verification throttle Redis unavailable, using in-memory fallback: ${error.message}`,
        );
      }
      this.redisAvailable = false;
    });
  }

  /** Window in ms for failed-attempt counting (default 15 minutes). */
  windowMs(): number {
    return Number(
      this.config.get<string>('VERIFICATION_ATTEMPT_WINDOW_MS') ?? 900000,
    );
  }

  /** Max failed attempts in the window before the code/token is voided. */
  maxFailures(): number {
    return Number(
      this.config.get<string>('VERIFICATION_ATTEMPT_MAX_FAILURES') ?? 5,
    );
  }

  /** Record one failed attempt for `key`; returns the failure count in the window. */
  async recordFailure(key: string): Promise<number> {
    const redisKey = `verify-fail:${key}`;
    if (this.redisAvailable) {
      try {
        if (this.redis.status === 'wait') {
          await this.redis.connect();
        }
        const count = Number(
          await this.redis.eval(
            INCREMENT_SCRIPT,
            1,
            redisKey,
            String(this.windowMs()),
          ),
        );
        return count;
      } catch (error) {
        this.redisAvailable = false;
        this.logger.warn(
          `Verification throttle Redis failed, using in-memory fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const now = Date.now();
    const bucket = this.memory.get(redisKey);
    if (!bucket || bucket.resetAt <= now) {
      this.memory.set(redisKey, { count: 1, resetAt: now + this.windowMs() });
      return 1;
    }
    bucket.count += 1;
    if (this.memory.size > 5000) this.cleanupMemory(now);
    return bucket.count;
  }

  /** Current failure count for `key` in the window (0 when none). */
  async failureCount(key: string): Promise<number> {
    const redisKey = `verify-fail:${key}`;
    if (this.redisAvailable) {
      try {
        if (this.redis.status === 'wait') {
          await this.redis.connect();
        }
        return Number((await this.redis.get(redisKey)) ?? 0);
      } catch {
        this.redisAvailable = false;
      }
    }
    const bucket = this.memory.get(redisKey);
    return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
  }

  /** Clear the failure count for `key` (call on success). */
  async clear(key: string): Promise<void> {
    const redisKey = `verify-fail:${key}`;
    this.memory.delete(redisKey);
    if (this.redisAvailable) {
      try {
        if (this.redis.status === 'wait') {
          await this.redis.connect();
        }
        await this.redis.del(redisKey);
      } catch {
        this.redisAvailable = false;
      }
    }
  }

  private cleanupMemory(now: number) {
    for (const [key, bucket] of this.memory.entries()) {
      if (bucket.resetAt <= now) this.memory.delete(key);
    }
  }
}
