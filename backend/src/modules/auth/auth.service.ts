import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'node:crypto';
import { Request } from 'express';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { formatUserPublicId } from '../../common/public-id';
import { generateOpaqueToken } from '../../common/tokens';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestRegistrationCodeDto } from './dto/request-registration-code.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import { SessionService } from './session.service';
import { VerificationThrottleService } from './verification-throttle.service';

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
    private readonly verificationThrottle: VerificationThrottleService,
  ) {}

  registrationEnabled() {
    return this.settings.isRegistrationEnabled();
  }

  registrationVerificationRequired() {
    return this.mail.isRegistrationVerificationRequired();
  }

  async requestRegistrationCode(
    dto: RequestRegistrationCodeDto,
    request: Request,
  ) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const recentCount = await this.prisma.emailVerificationCode.count({
      where: {
        email,
        purpose: 'register',
        createdAt: {
          gte: new Date(Date.now() - 15 * 60 * 1000),
        },
      },
    });

    if (recentCount >= 3) {
      throw new BadRequestException('Verification code requested too often');
    }

    await this.prisma.emailVerificationCode.updateMany({
      where: {
        email,
        purpose: 'register',
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        usedAt: new Date(),
      },
    });

    // Registration codes stay 6 digits: the frontend and RegisterDto
    // enforce exactly 6 characters, and with the 5-failed-attempt voiding
    // in verifyRegistrationCode() a 6-digit code can only be guessed 5
    // times per email per 15 minutes, so lengthening it buys nothing
    // while breaking existing clients.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresMinutes = Number(
      this.config.get<string>('REGISTRATION_CODE_EXPIRES_MINUTES') ?? 10,
    );
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

    await this.prisma.emailVerificationCode.create({
      data: {
        email,
        codeHash: this.hashVerificationCode(email, code),
        purpose: 'register',
        expiresAt,
        ip: this.ip(request),
        userAgent: request.headers['user-agent'],
      },
    });

    await this.mail.sendRegistrationCode({
      to: email,
      code,
      expiresMinutes,
    });

    return { ok: true };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const [userCount, verificationRequired] = await Promise.all([
      this.prisma.user.count(),
      this.registrationVerificationRequired(),
    ]);
    const bootstrapWithoutVerification =
      userCount === 0 && !verificationRequired;
    if (!bootstrapWithoutVerification) {
      if (!dto.verificationCode) {
        throw new BadRequestException('Verification code is required');
      }
      await this.verifyRegistrationCode(email, dto.verificationCode);
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const defaultQuotaBytes = await this.getDefaultQuotaBytes();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const user = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.user.findUnique({
              where: { email },
            });

            if (existing) {
              throw new ConflictException('Email is already registered');
            }

            const userCount = await tx.user.count();
            if (bootstrapWithoutVerification && userCount !== 0) {
              throw new BadRequestException(
                'Email verification is required after the first account',
              );
            }
            return tx.user.create({
              data: {
                email,
                name: this.defaultName(email),
                passwordHash,
                role: userCount === 0 ? UserRole.ADMIN : UserRole.USER,
                quotaBytes: defaultQuotaBytes,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return this.createSession(user);
      } catch (error) {
        if (attempt === 0 && this.isTransactionConflict(error)) {
          continue;
        }

        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException('Email is already registered');
        }

        throw error;
      }
    }

    throw new ConflictException('Registration could not be completed');
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

    const user = await this.prisma.user
      .update({
        where: { id: userId },
        data: {
          name: dto.name,
          email,
          avatarUrl: dto.avatarUrl === null ? null : dto.avatarUrl?.trim(),
        },
      })
      .catch((error: unknown) => {
        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException('Email is already registered');
        }

        throw error;
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

    // Resolve the reset URL before minting a token: buildResetUrl() refuses
    // to build one when APP_PUBLIC_URL is not configured (it never falls
    // back to the request Origin/Host, which an attacker controls). In
    // that case no token is created and no email is sent; the caller still
    // gets the generic response so nothing leaks.
    const token = generateOpaqueToken();
    let resetUrl: string;
    try {
      resetUrl = await this.buildResetUrl(token);
    } catch (error) {
      this.logger.warn(
        `Password reset not sent for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return genericResponse;
    }

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
        resetUrl,
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

  async logout(token: string) {
    if (token) {
      await this.sessions.revoke(token);
    }
    return { ok: true };
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
      await this.recordFailedResetAttempt(resetToken?.userId, dto.token);
      throw new BadRequestException(
        'Password reset link is invalid or expired',
      );
    }

    const now = new Date();
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: {
          id: resetToken.id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      if (claimed.count !== 1) {
        throw new BadRequestException(
          'Password reset link is invalid or expired',
        );
      }

      await tx.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
        },
      });
      await tx.passwordResetToken.updateMany({
        where: {
          userId: resetToken.userId,
          id: { not: resetToken.id },
          usedAt: null,
        },
        data: { usedAt: now },
      });
    });
    await this.sessions.revokeUser(resetToken.userId);
    await this.verificationThrottle.clear(`reset:${resetToken.userId}`);

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
    avatarUrl?: string | null;
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
    avatarUrl?: string | null;
    quotaBytes: bigint;
    usedBytes: bigint;
  }) {
    return {
      id: user.id,
      publicId: formatUserPublicId(user.publicId),
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl ?? null,
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

  private isTransactionConflict(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private hashVerificationCode(email: string, code: string) {
    return createHash('sha256').update(`${email}:${code}`).digest('hex');
  }

  private async verifyRegistrationCode(email: string, code: string) {
    const key = `register:${email}`;
    if (
      (await this.verificationThrottle.failureCount(key)) >=
      this.verificationThrottle.maxFailures()
    ) {
      await this.voidRegistrationCodes(email);
      throw new HttpException(
        'Too many failed verification attempts; the code has been voided. Request a new code.',
        429,
      );
    }

    const now = new Date();
    const token = await this.prisma.emailVerificationCode.findFirst({
      where: {
        email,
        purpose: 'register',
        codeHash: this.hashVerificationCode(email, code.trim()),
        usedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      const failures = await this.verificationThrottle.recordFailure(key);
      if (failures >= this.verificationThrottle.maxFailures()) {
        await this.voidRegistrationCodes(email);
        throw new HttpException(
          'Too many failed verification attempts; the code has been voided. Request a new code.',
          429,
        );
      }
      throw new BadRequestException('Verification code is invalid or expired');
    }

    await this.verificationThrottle.clear(key);
    await this.prisma.emailVerificationCode.update({
      where: { id: token.id },
      data: { usedAt: now },
    });
  }

  private async voidRegistrationCodes(email: string) {
    await this.prisma.emailVerificationCode.updateMany({
      where: { email, purpose: 'register', usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  private async recordFailedResetAttempt(
    userId: string | undefined,
    token: string,
  ) {
    // Keyed per user (i.e. per email) when the token maps to one, so 5
    // failures void that user's live reset tokens; unknown tokens are
    // keyed by token hash so guessing one token is throttled too.
    const key = userId
      ? `reset:${userId}`
      : `reset:unknown:${this.hashToken(token).slice(0, 12)}`;
    const failures = await this.verificationThrottle.recordFailure(key);
    if (userId && failures >= this.verificationThrottle.maxFailures()) {
      await this.prisma.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      throw new HttpException(
        'Too many failed password reset attempts; the reset link has been voided. Request a new one.',
        429,
      );
    }
  }

  private defaultName(email: string) {
    const prefix = email.split('@')[0] || 'user';
    const cleaned = prefix.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
    return cleaned.length >= 2 ? cleaned : `${cleaned || 'user'}_user`;
  }

  private async buildResetUrl(token: string) {
    // Never fall back to the request Origin/Host headers: they are
    // attacker-controlled, and a reset link built from them hands the token
    // to an attacker domain. Only the configured public URL is trusted.
    // If it is not configured, refuse — the caller logs this and returns a
    // generic response, so the caller cannot tell whether mail was sent.
    const configured = await this.settings.getAppPublicUrl();
    if (!configured) {
      throw new Error(
        'APP_PUBLIC_URL is not configured; password reset email not sent',
      );
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(configured);
    } catch {
      throw new Error(
        `APP_PUBLIC_URL is not a valid URL (${configured}); password reset email not sent`,
      );
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error(
        'APP_PUBLIC_URL must use http:// or https://; password reset email not sent',
      );
    }

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
