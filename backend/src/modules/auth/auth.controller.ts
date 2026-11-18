import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/current-user.decorator';
import { formatUserPublicId } from '../../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestRegistrationCodeDto } from './dto/request-registration-code.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginThrottleGuard } from './login-throttle.guard';
import { PasswordResetThrottleGuard } from './password-reset-throttle.guard';
import { AuthAttemptThrottleGuard } from './auth-attempt-throttle.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly loginThrottle: LoginThrottleGuard,
  ) {}

  @Get('registration-status')
  async registrationStatus() {
    const [userCount, registrationEnabled, smtpConfigured] = await Promise.all([
      this.prisma.user.count(),
      this.auth.registrationEnabled(),
      this.auth.registrationVerificationRequired(),
    ]);

    return {
      firstUser: userCount === 0,
      registrationEnabled,
      emailVerificationRequired: userCount > 0 || smtpConfigured,
    };
  }

  @Post('register')
  @UseGuards(AuthAttemptThrottleGuard)
  async register(@Body() dto: RegisterDto) {
    // Bootstrap: the very first account may always register and becomes
    // the admin, even when registration is otherwise closed. Without this
    // a fresh install with the default ALLOW_REGISTER=false can never
    // create an admin and is unusable out of the box (the service-level
    // bootstrap in AuthService.register is unreachable behind this gate).
    const userCount = await this.prisma.user.count();
    if (userCount > 0 && !(await this.auth.registrationEnabled())) {
      throw new ForbiddenException('Registration is disabled');
    }

    return this.auth.register(dto);
  }

  @Post('registration-code')
  async requestRegistrationCode(
    @Body() dto: RequestRegistrationCodeDto,
    @Req() request: Request,
  ) {
    if (!(await this.auth.registrationEnabled())) {
      throw new ForbiddenException('Registration is disabled');
    }

    return this.auth.requestRegistrationCode(dto, request);
  }

  @Post('login')
  @UseGuards(LoginThrottleGuard)
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const session = await this.auth.login(dto);
    this.loginThrottle.clear(request);
    return session;
  }

  @Post('password-reset/request')
  @UseGuards(PasswordResetThrottleGuard)
  requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Req() request: Request,
  ) {
    return this.auth.requestPasswordReset(dto, request);
  }

  @Post('password-reset/confirm')
  @UseGuards(AuthAttemptThrottleGuard)
  resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request) {
    return this.auth.resetPassword(dto, request);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(@Req() request: Request) {
    // Revoke the exact session token presented, so a copied token stops
    // working immediately. Idempotent: revoking twice is a no-op.
    return this.auth.logout(this.extractBearerToken(request));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async me(@CurrentUser() user: CurrentUserPayload) {
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        publicId: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        quotaBytes: true,
        usedBytes: true,
      },
    });

    // Same shape as serializeUser(): no createdAt (the frontend User
    // type has no such field).

    return {
      ...profile,
      publicId: formatUserPublicId(profile.publicId),
      quotaBytes: Number(profile.quotaBytes),
      usedBytes: Number(profile.usedBytes),
    };
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  updateProfile(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, dto);
  }

  private extractBearerToken(request: Request) {
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const [type, token] = value?.split(' ') ?? [];
    return type?.toLowerCase() === 'bearer' && token ? token : '';
  }
}
