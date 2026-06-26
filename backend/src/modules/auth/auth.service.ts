import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { formatUserPublicId } from '../../common/public-id';
import { generateOpaqueToken } from '../../common/tokens';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const userCount = await this.prisma.user.count();
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const defaultQuotaBytes = await this.getDefaultQuotaBytes();
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash,
        role: userCount === 0 ? UserRole.ADMIN : UserRole.USER,
        quotaBytes: defaultQuotaBytes,
      },
    });

    return this.createSession(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.disabled) {
      throw new UnauthorizedException('Account is disabled');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.createSession(updated);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const email = dto.email?.toLowerCase().trim();
    if (email) {
      const existing = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing && existing.id !== userId) {
        throw new ConflictException('Email is already registered');
      }
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        email,
      },
    });

    return this.serializeUser(user);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, 12),
        passwordChangedAt: new Date(),
      },
    });
    await this.sessions.revokeUser(userId);

    return { ok: true };
  }

  async requestPasswordReset(dto: RequestPasswordResetDto, request: Request) {
    const genericResponse = { ok: true };
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        name: true,
        disabled: true,
      },
    });

    if (!user || user.disabled) {
      await this.audit.record(
        { request },
        {
          action: 'auth.password_reset_requested',
          target: 'user',
          metadata: {
            status: user?.disabled ? 'disabled' : 'not_found',
          },
        },
      );
      return genericResponse;
    }

    const recentCount = await this.prisma.passwordResetToken.count({
      where: {
        userId: user.id,
        createdAt: {
          gte: new Date(Date.now() - 15 * 60 * 1000),
        },
      },
    });

    if (recentCount >= 3) {
      await this.audit.record(
        {
          actorId: user.id,
          request,
        },
        {
          action: 'auth.password_reset_rate_limited',
          target: 'user',
          targetId: user.id,
        },
      );
      return genericResponse;
    }

    await this.prisma.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        usedAt: new Date(),
      },
    });

    const token = generateOpaqueToken();
    const expiresMinutes = Number(
      this.config.get<string>('PASSWORD_RESET_EXPIRES_MINUTES') ?? 30,
    );
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt,
        ip: this.ip(request),
        userAgent: request.headers['user-agent'],
      },
    });

    try {
      await this.mail.sendPasswordReset({
        to: user.email,
        name: user.name,
        resetUrl: await this.buildResetUrl(request, token),
        expiresMinutes,
      });
    } catch (error) {
      this.logger.error(
        `Password reset email failed for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.audit.record(
      {
        actorId: user.id,
        request,
      },
      {
        action: 'auth.password_reset_requested',
        target: 'user',
        targetId: user.id,
        metadata: {
          expiresAt: expiresAt.toISOString(),
        },
      },
    );

    return genericResponse;
  }

  async resetPassword(dto: ResetPasswordDto, request: Request) {
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(dto.token) },
      include: {
        user: {
          select: {
            id: true,
            disabled: true,
          },
        },
      },
    });

    if (
      !resetToken ||
      resetToken.usedAt ||
      resetToken.expiresAt <= new Date() ||
      resetToken.user.disabled
    ) {
      throw new BadRequestException(
        'Password reset link is invalid or expired',
      );
    }

    const now = new Date();
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
        },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: now },
      }),
      this.prisma.passwordResetToken.updateMany({
        where: {
          userId: resetToken.userId,
          id: { not: resetToken.id },
          usedAt: null,
        },
        data: { usedAt: now },
      }),
    ]);
    await this.sessions.revokeUser(resetToken.userId);

    await this.audit.record(
      {
        actorId: resetToken.userId,
        request,
      },
      {
        action: 'auth.password_reset_completed',
        target: 'user',
        targetId: resetToken.userId,
      },
    );

    return { ok: true };
  }

  private async createSession(user: {
    id: string;
    publicId: number;
    email: string;
    name: string;
    role: UserRole;
    disabled?: boolean;
    quotaBytes: bigint;
    usedBytes: bigint;
    passwordChangedAt?: Date | null;
  }) {
    const token = await this.sessions.create(user.id);

    return {
      accessToken: token,
      user: this.serializeUser(user),
    };
  }

  private serializeUser(user: {
    id: string;
    publicId: number;
    email: string;
    name: string;
    role: UserRole;
    quotaBytes: bigint;
    usedBytes: bigint;
  }) {
    return {
      id: user.id,
      publicId: formatUserPublicId(user.publicId),
      email: user.email,
      name: user.name,
      role: user.role,
      quotaBytes: Number(user.quotaBytes),
      usedBytes: Number(user.usedBytes),
    };
  }

  private async getDefaultQuotaBytes() {
    const setting = await this.prisma.appSetting.findFirst({
      where: {
        owner: {
          role: UserRole.ADMIN,
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: { defaultQuotaBytes: true },
    });

    return setting?.defaultQuotaBytes ?? BigInt(1024 * 1024 * 1024);
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async buildResetUrl(request: Request, token: string) {
    const configured = await this.settings.getAppPublicUrl();
    const baseUrl =
      configured ||
      request.headers.origin ||
      `${request.protocol}://${request.get('host')}`;

    const url = new URL('/reset-password', baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private ip(request: Request) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }

    return request.ip;
  }
}
