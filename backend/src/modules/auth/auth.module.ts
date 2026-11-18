import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottleGuard } from './login-throttle.guard';
import { PasswordResetThrottleGuard } from './password-reset-throttle.guard';
import { AuthAttemptThrottleGuard } from './auth-attempt-throttle.guard';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionModule } from './session.module';
import { VerificationThrottleService } from './verification-throttle.service';

@Module({
  imports: [
    ConfigModule,
    SessionModule,
    AuditModule,
    MailModule,
    SettingsModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    LoginThrottleGuard,
    PasswordResetThrottleGuard,
    AuthAttemptThrottleGuard,
    VerificationThrottleService,
  ],
  exports: [JwtAuthGuard, SessionModule],
})
export class AuthModule {}
