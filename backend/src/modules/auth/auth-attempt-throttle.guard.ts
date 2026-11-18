import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clientIp } from '../../common/request-meta';

/**
 * Per-attempt throttle for the routes that verify a secret the user typed
 * in — POST /auth/register (registration code) and
 * POST /auth/password-reset/confirm (reset token). Mirrors the in-memory
 * buckets of LoginThrottleGuard / PasswordResetThrottleGuard: at most 10
 * attempts per IP + identifier in 15 minutes.
 *
 * This is the rate layer. The failure layer lives in AuthService via
 * VerificationThrottleService: 5 *failed* attempts per email in 15 minutes
 * voids the code/token outright.
 */
type AttemptBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class AuthAttemptThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const windowMs = Number(
      this.config.get<string>('AUTH_ATTEMPT_WINDOW_MS') ?? 900000,
    );
    const max = Number(this.config.get<string>('AUTH_ATTEMPT_MAX') ?? 10);
    const identifier = String(request.body?.email ?? request.body?.token ?? '')
      .toLowerCase()
      .trim();
    const key = `${clientIp(request)}:${identifier || 'unknown'}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      throw new HttpException('Too many attempts, please try again later', 429);
    }

    if (this.buckets.size > 5000) {
      this.cleanup(now);
    }

    return true;
  }

  private cleanup(now: number) {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
