import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ImageStatus, StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { lookup } from 'mime-types';
import { AuditContext, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  StorageRuntimeConfig,
  StorageService,
} from '../storage/storage.service';
import {
  MigrateImagesDto,
  ReprocessImagesDto,
} from './dto/storage-maintenance.dto';

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue('image-processing')
    private readonly processingQueue: Queue,
  ) {}

  async summary() {
    const [byProvider, missingDerived, failed, processing] = await Promise.all([
      this.prisma.image.groupBy({
        by: ['storageProvider'],
        where: { status: { not: ImageStatus.DELETED } },
        _count: { _all: true },
      }),
      this.prisma.image.count({
        where: {
          status: ImageStatus.READY,
          OR: [{ thumbKey: null }, { webpKey: null }],
        },
      }),
      this.prisma.image.count({
        where: { status: ImageStatus.FAILED },
      }),
      this.prisma.image.count({
        where: { status: ImageStatus.PROCESSING },
      }),
    ]);

    return {
      byProvider: byProvider.map((item) => ({
        provider: item.storageProvider,
        count: item._count._all,
      })),
      missingDerived,
      failed,
      processing,
    };
  }

  async reprocess(dto: ReprocessImagesDto, context: AuditContext) {
    const images = await this.prisma.image.findMany({
      where: {
        status: { not: ImageStatus.DELETED },
        id: dto.imageIds?.length ? { in: dto.imageIds } : undefined,
        OR: dto.missingOnly
          ? [{ thumbKey: null }, { webpKey: null }]
          : undefined,
      },
      select: {
        id: true,
        storageKey: true,
      },
      take: dto.imageIds?.length ? undefined : (dto.limit ?? 100),
    });

    await this.prisma.image.updateMany({
      where: { id: { in: images.map((image) => image.id) } },
      data: { status: ImageStatus.PROCESSING },
    });

    await Promise.all(
      images.map((image) =>
        this.processingQueue.add('process-image', {
          imageId: image.id,
          storageKey: image.storageKey,
        }),
      ),
    );

    await this.audit.record(context, {
      action: 'maintenance.reprocess',
      target: 'image',
      metadata: {
        count: images.length,
        missingOnly: Boolean(dto.missingOnly),
      },
    });

    return { affected: images.length };
  }

  async migrate(actorId: string, dto: MigrateImagesDto, context: AuditContext) {
    const currentSetting = await this.settings.getRuntime(actorId);
    const targetSetting = {
      ...currentSetting,
      storageProvider: dto.targetProvider,
    };
    const images = await this.prisma.image.findMany({
      where: {
        status: { not: ImageStatus.DELETED },
        storageProvider: { not: dto.targetProvider },
        id: dto.imageIds?.length ? { in: dto.imageIds } : undefined,
      },
      select: {
        id: true,
        ownerId: true,
        storageProvider: true,
        storageKey: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
      },
      take: dto.imageIds?.length ? undefined : (dto.limit ?? 50),
    });

    if (!images.length) {
      return { affected: 0, failed: 0 };
    }

    let migrated = 0;
    let failed = 0;
    for (const image of images) {
      try {
        await this.migrateOne(image, targetSetting);
        migrated += 1;

        if (dto.reprocess ?? true) {
          await this.processingQueue.add('process-image', {
            imageId: image.id,
            storageKey: image.storageKey,
          });
        }
      } catch {
        failed += 1;
        await this.prisma.image.update({
          where: { id: image.id },
          data: { status: ImageStatus.FAILED },
        });
      }
    }

    await this.audit.record(context, {
      action: 'maintenance.migrate_storage',
      target: 'image',
      metadata: {
        targetProvider: dto.targetProvider,
        migrated,
        failed,
      },
    });

    return { affected: migrated, failed };
  }

  private async migrateOne(
    image: {
      id: string;
      ownerId: string;
      storageProvider: StorageProvider;
      storageKey: string;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint;
    },
    targetSetting: StorageRuntimeConfig,
  ) {
    const sourceSetting = {
      ...(await this.settings.getRuntime(image.ownerId)),
      storageProvider: image.storageProvider,
    };
    const buffer = await this.storage.getObjectBuffer(
      image.storageKey,
      sourceSetting,
    );
    if (buffer.length !== Number(image.sizeBytes)) {
      throw new BadRequestException(
        'Stored object size does not match database',
      );
    }

    await this.storage.putObject({
      key: image.storageKey,
      body: buffer,
      contentType:
        image.mimeType ||
        lookup(image.originalName) ||
        'application/octet-stream',
      setting: targetSetting,
    });

    await this.prisma.image.update({
      where: { id: image.id },
      data: {
        storageProvider: targetSetting.storageProvider,
        publicUrl: this.storage.getPublicUrlWithBase(
          image.storageKey,
          targetSetting,
        ),
        thumbKey: null,
        thumbUrl: null,
        webpKey: null,
        webpUrl: null,
        avifKey: null,
        avifUrl: null,
        status: ImageStatus.PROCESSING,
      },
    });
  }
}
