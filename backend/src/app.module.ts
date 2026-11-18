import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AlbumsModule } from './modules/albums/albums.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { SessionModule } from './modules/auth/session.module';
import { ImagesModule } from './modules/images/images.module';
import { MailModule } from './modules/mail/mail.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ProcessorModule } from './modules/processor/processor.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StorageModule } from './modules/storage/storage.module';
import { SystemModule } from './modules/system/system.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { UploadModule } from './modules/upload/upload.module';
import { UsersModule } from './modules/users/users.module';
import { validateEnv } from './config/env-validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast on placeholder passwords, a missing APP_PUBLIC_URL in
      // production, or malformed URLs/ports. See env-validation.ts.
      validate: validateEnv,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST') ?? 'localhost',
          port: config.get<number>('REDIS_PORT') ?? 6379,
        },
      }),
    }),
    PrismaModule,
    SessionModule,
    AuditModule,
    AuthModule,
    ApiKeysModule,
    UsersModule,
    AlbumsModule,
    ImagesModule,
    MailModule,
    SettingsModule,
    StorageModule,
    MaintenanceModule,
    SystemModule,
    UploadModule,
    TelegramModule,
    ProcessorModule,
  ],
})
export class AppModule {}
