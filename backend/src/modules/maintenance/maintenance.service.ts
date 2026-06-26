import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ImageStatus, StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { lookup } from 'mime-types';
import { AuditContext, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import {
  MigrateImagesDto,
  ReprocessImagesDto,
} from './dto/storage-maintenance.dto';

type RuntimeUploadSetting = Awaited<ReturnType<SettingsService['getRuntime']>>;

type DerivedCandidate = {
  ownerId: string;
  thumbKey: string | null;
  webpKey: string | null;
  avifKey: string | null;
};

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
    const [byProvider, failed, processing, derivedCandidates] =
      await Promise.all([
        this.prisma.image.groupBy({
          by: ['storageProvider'],
          where: { status: { not: ImageStatus.DELETED } },
          _count: { _all: true },
        }),
        this.prisma.image.count({
          where: { status: ImageStatus.FAILED },
        }),
        this.prisma.image.count({
          where: { status: ImageStatus.PROCESSING },
        }),
        this.prisma.image.findMany({
          where: { status: ImageStatus.READY },
          select: {
            ownerId: true,
            thumbKey: true,
            webpKey: true,
            avifKey: true,
          },
        }),
      ]);
    const missingDerived = await this.countMissingDerived(derivedCandidates);

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
    const limit = dto.imageIds?.length ? undefined : (dto.limit ?? 100);
    const candidates = await this.prisma.image.findMany({
      where: {
        status: dto.missingOnly
          ? ImageStatus.READY
          : { not: ImageStatus.DELETED },
        uploadedAt: { not: null },
        id: dto.imageIds?.length ? { in: dto.imageIds } : undefined,
      },
      select: {
        id: true,
        ownerId: true,
        storageKey: true,
        thumbKey: true,
        webpKey: true,
        avifKey: true,
      },
      take: dto.missingOnly || dto.imageIds?.length ? undefined : limit,
    });
    const images = dto.missingOnly
      ? (await this.filterMissingDerived(candidates)).slice(
          0,
          limit ?? candidates.length,
        )
      : candidates;

    if (images.length) {
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
    }

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
        await this.migrateOne(image, dto.targetProvider);
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
    targetProvider: StorageProvider,
  ) {
    const runtimeSetting = await this.settings.getRuntime(image.ownerId);
    const sourceSetting = {
      ...runtimeSetting,
      storageProvider: image.storageProvider,
    };
    const targetSetting = {
      ...runtimeSetting,
      storageProvider: targetProvider,
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

  private async countMissingDerived(images: DerivedCandidate[]) {
    const filtered = await this.filterMissingDerived(images);
    return filtered.length;
  }

  private async filterMissingDerived<T extends DerivedCandidate>(images: T[]) {
    const settingCache = new Map<string, RuntimeUploadSetting>();
    const filtered: T[] = [];

    for (const image of images) {
      const setting = await this.runtimeForOwner(image.ownerId, settingCache);
      if (this.needsDerivedRepair(image, setting)) {
        filtered.push(image);
      }
    }

    return filtered;
  }

  private async runtimeForOwner(
    ownerId: string,
    cache: Map<string, RuntimeUploadSetting>,
  ) {
    const cached = cache.get(ownerId);
    if (cached) {
      return cached;
    }

    const setting = await this.settings.getRuntime(ownerId);
    cache.set(ownerId, setting);
    return setting;
  }

  private needsDerivedRepair(
    image: DerivedCandidate,
    setting: RuntimeUploadSetting,
  ) {
    return (
      (setting.generateThumbnail && !image.thumbKey) ||
      (setting.generateWebp && !image.webpKey) ||
      (setting.generateAvif && !image.avifKey)
    );
  }
}
