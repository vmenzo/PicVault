import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'image-processing',
    }),
    SettingsModule,
    StorageModule,
  ],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
