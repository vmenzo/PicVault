import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { clientIp } from './request-meta';

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(config.get<string | number>('REDIS_PORT') ?? 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const windowMs = Number(
      this.config.get<string>('RATE_LIMIT_WINDOW_MS') ?? 60000,
    );
    const max = Number(this.config.get<string>('RATE_LIMIT_MAX') ?? 240);
    const route = request.route?.path ?? request.path ?? request.url;
    const key = `rate-limit:${clientIp(request)}:${request.method}:${route}`;
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }

    const count = Number(
      await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowMs)),
    );
    if (count > max) {
      throw new HttpException('Too many requests', 429);
    }

    return true;
  }
}
