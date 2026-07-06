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
import { ConfigService } from '@nestjs/config';
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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly loginThrottle: LoginThrottleGuard,
  ) {}

  @Get('registration-status')
  async registrationStatus() {
    const userCount = await this.prisma.user.count();

    return {
      firstUser: userCount === 0,
    };
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    if (this.config.get<string>('ALLOW_REGISTER') !== 'true') {
      throw new ForbiddenException('Registration is disabled');
    }

    return this.auth.register(dto);
  }

  @Post('registration-code')
  requestRegistrationCode(
    @Body() dto: RequestRegistrationCodeDto,
    @Req() request: Request,
  ) {
    if (this.config.get<string>('ALLOW_REGISTER') !== 'true') {
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
  resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request) {
    return this.auth.resetPassword(dto, request);
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
        role: true,
        quotaBytes: true,
        usedBytes: true,
        createdAt: true,
      },
    });

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
}
