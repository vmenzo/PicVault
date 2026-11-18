import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { generateOpaqueToken } from '../../common/tokens';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Expired sessions were never cleaned up (cleanupExpired() had no
    // caller). Sweep hourly, plus once shortly after boot, so revoked /
    // expired rows do not accumulate.
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpiredSafe(),
      60 * 60 * 1000,
    );
    this.cleanupTimer.unref();
    setTimeout(() => void this.cleanupExpiredSafe(), 60_000).unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanupExpiredSafe() {
    try {
      await this.cleanupExpired();
    } catch (error) {
      this.logger.error(
        'Expired session cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async create(userId: string) {
    const token = generateOpaqueToken();
    await this.prisma.authSession.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + this.ttlMs()),
      },
    });

    return token;
  }

  async validate(token: string) {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        user: {
          select: {
            id: true,
            publicId: true,
            email: true,
            role: true,
            disabled: true,
            passwordChangedAt: true,
          },
        },
      },
    });

    if (!session || session.expiresAt <= new Date() || session.user.disabled) {
      return null;
    }

    if (
      session.user.passwordChangedAt &&
      session.createdAt < session.user.passwordChangedAt
    ) {
      await this.revoke(token);
      return null;
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });

    return session.user;
  }

  async revoke(token: string) {
    await this.prisma.authSession.deleteMany({
      where: { tokenHash: this.hash(token) },
    });
  }

  async revokeUser(userId: string) {
    await this.prisma.authSession.deleteMany({
      where: { userId },
    });
  }

  async cleanupExpired() {
    await this.prisma.authSession.deleteMany({
      where: {
        expiresAt: {
          lte: new Date(),
        },
      },
    });
  }

  hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlMs() {
    const value = this.config.get<string>('TOKEN_EXPIRES_IN') ?? '7d';
    const match = value.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000;

    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return amount * multipliers[unit];
  }
}
