import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ImageStatus, StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { constants } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  StorageRuntimeConfig,
  StorageService,
} from '../storage/storage.service';

type ServiceState = 'ok' | 'warning' | 'error';
type ServiceHealth = {
  status: ServiceState;
  message?: string;
};

type RuntimeStorageSetting = StorageRuntimeConfig & {
  storageProvider: StorageProvider;
};

const emptyQueueCounts = {
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
};

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    @InjectQueue('image-processing')
    private readonly imageQueue: Queue,
  ) {}

  ping() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * Unauthenticated readiness probe for orchestrators / the frontend
   * /healthz handler. Unlike health() above it needs no admin user: it
   * only proves the process can reach Postgres and Redis right now.
   * Returns status 'error' (never throws) when either dependency is down,
   * so callers can map it to a non-2xx HTTP status.
   */
  async readiness() {
    const [database, redis] = await Promise.all([
      this.databasePing(),
      this.redisPing(),
    ]);
    const ok = database.status === 'ok' && redis.status === 'ok';
    return {
      status: ok ? 'ok' : 'error',
      uptimeSeconds: Math.round(process.uptime()),
      services: { database, redis },
    };
  }

  private async databasePing(): Promise<ServiceHealth> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.serviceOk();
    } catch (error) {
      return this.serviceError(error);
    }
  }

  private async redisPing(): Promise<ServiceHealth> {
    try {
      // A job-counts call round-trips to Redis through the BullMQ client.
      await this.imageQueue.getJobCounts('waiting');
      return this.serviceOk();
    } catch (error) {
      return this.serviceError(error);
    }
  }

  async health(ownerId: string) {
    const startedAt = Date.now() - Math.round(process.uptime() * 1000);
    const [database, queueServices, runtime] = await Promise.all([
      this.databaseSnapshot(),
      this.queueStatus(),
      this.runtimeStorageSetting(ownerId),
    ]);
    const storage = await this.storageStatus(
      runtime.setting,
      runtime.errorMessage,
    );
    const disk = await this.serviceStorageUsage(runtime.setting);
    const statuses = [
      database.database,
      queueServices.redis,
      queueServices.queue,
      storage,
      disk,
    ];

    return {
      status: this.overallStatus(statuses),
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      nodeVersion: process.version,
      memory: process.memoryUsage(),
      services: {
        database: database.database,
        redis: queueServices.redis,
        storage,
        telegram: {
          enabledAccounts: database.telegramEnabled,
        },
        queue: queueServices.queue,
        disk,
      },
      counts: database.counts,
    };
  }

  private async databaseSnapshot() {
    try {
      const [users, images, albums, apiKeys, telegramEnabled] =
        await this.prisma.$transaction([
          this.prisma.user.count(),
          this.prisma.image.count(),
          this.prisma.album.count(),
          this.prisma.apiKey.count(),
          this.prisma.appSetting.count({
            where: {
              telegramBotEnabled: true,
              telegramBotToken: { not: null },
            },
          }),
        ]);

      return {
        database: this.serviceOk(),
        telegramEnabled,
        counts: {
          users,
          images,
          albums,
          apiKeys,
        },
      };
    } catch (error) {
      return {
        database: this.serviceError(error),
        telegramEnabled: 0,
        counts: {
          users: 0,
          images: 0,
          albums: 0,
          apiKeys: 0,
        },
      };
    }
  }

  private async queueStatus() {
    const redis = {
      host: this.config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(this.config.get<string | number>('REDIS_PORT') ?? 6379),
    };

    try {
      const queueCounts = await this.imageQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      );

      return {
        redis: {
          ...redis,
          ...this.serviceOk(),
        },
        queue: {
          ...queueCounts,
          ...this.serviceOk(),
        },
      };
    } catch (error) {
      const health = this.serviceError(error);
      return {
        redis: {
          ...redis,
          ...health,
        },
        queue: {
          ...emptyQueueCounts,
          ...health,
        },
      };
    }
  }

  private async runtimeStorageSetting(ownerId: string): Promise<{
    setting: RuntimeStorageSetting;
    errorMessage?: string;
  }> {
    try {
      const setting = await this.settings.getRuntime(ownerId);
      return {
        setting: {
          storageProvider: setting.storageProvider,
          publicBaseUrl: setting.publicBaseUrl,
          s3Endpoint: setting.s3Endpoint,
          s3Region: setting.s3Region,
          s3Bucket: setting.s3Bucket,
          s3AccessKey: setting.s3AccessKey,
          s3SecretKey: setting.s3SecretKey,
          s3ForcePathStyle: setting.s3ForcePathStyle,
          localStoragePath: setting.localStoragePath,
        },
      };
    } catch (error) {
      return {
        setting: this.fallbackStorageSetting(),
        errorMessage: errorMessage(error),
      };
    }
  }

  private fallbackStorageSetting(): RuntimeStorageSetting {
    return {
      storageProvider: StorageProvider.LOCAL,
      publicBaseUrl: null,
      s3Endpoint: this.config.get<string>('S3_ENDPOINT') ?? null,
      s3Region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
      s3Bucket: this.config.get<string>('S3_BUCKET') ?? null,
      s3AccessKey: this.config.get<string>('S3_ACCESS_KEY') ?? null,
      s3SecretKey: this.config.get<string>('S3_SECRET_KEY') ?? null,
      s3ForcePathStyle:
        (this.config.get<string>('S3_FORCE_PATH_STYLE') ?? 'true') === 'true',
      localStoragePath:
        this.config.get<string>('LOCAL_STORAGE_PATH') ??
        path.resolve(process.cwd(), 'storage'),
    };
  }

  private async storageStatus(
    setting: RuntimeStorageSetting,
    configError?: string,
  ) {
    const provider = setting.storageProvider;
    const endpoint =
      provider === StorageProvider.LOCAL
        ? this.localStoragePath(setting)
        : (setting.s3Endpoint?.trim() ?? '未配置');
    const bucket =
      provider === StorageProvider.LOCAL
        ? 'local'
        : (setting.s3Bucket?.trim() ?? '未配置');
    const publicBaseUrl =
      setting.publicBaseUrl?.trim() ||
      (provider === StorageProvider.LOCAL
        ? '/api/public/files'
        : (this.config.get<string>('PUBLIC_IMAGE_BASE_URL') ?? ''));

    if (configError) {
      return {
        provider,
        endpoint,
        bucket,
        publicBaseUrl,
        status: 'error' as const,
        message: `配置读取失败：${configError}`,
      };
    }

    if (provider === StorageProvider.LOCAL) {
      try {
        await mkdir(endpoint, { recursive: true });
        await access(endpoint, constants.R_OK | constants.W_OK);
        return {
          provider,
          endpoint,
          bucket,
          publicBaseUrl,
          ...this.serviceOk(),
        };
      } catch (error) {
        return {
          provider,
          endpoint,
          bucket,
          publicBaseUrl,
          ...this.serviceError(error),
        };
      }
    }

    const missing = [
      setting.s3Endpoint?.trim() ? null : 'Endpoint',
      setting.s3Bucket?.trim() ? null : 'Bucket',
      setting.s3AccessKey?.trim() ? null : 'Access Key',
      setting.s3SecretKey?.trim() ? null : 'Secret Key',
    ].filter(Boolean);

    if (missing.length) {
      return {
        provider,
        endpoint,
        bucket,
        publicBaseUrl,
        status: 'error' as const,
        message: `缺少 ${missing.join(', ')}`,
      };
    }

    try {
      await this.storage.testS3Connection(setting);
      return {
        provider,
        endpoint,
        bucket,
        publicBaseUrl,
        ...this.serviceOk(),
      };
    } catch (error) {
      return {
        provider,
        endpoint,
        bucket,
        publicBaseUrl,
        ...this.serviceError(error),
      };
    }
  }

  private async serviceStorageUsage(setting: RuntimeStorageSetting) {
    if (setting.storageProvider === StorageProvider.LOCAL) {
      return this.localStorageUsage(setting);
    }

    return this.objectStorageUsage(setting);
  }

  private async localStorageUsage(setting: RuntimeStorageSetting) {
    const targetPath = this.localStoragePath(setting);

    try {
      await mkdir(targetPath, { recursive: true });
      const usedBytes = await this.directorySize(targetPath);
      return {
        ...this.serviceOk(),
        provider: StorageProvider.LOCAL,
        scope: 'local-storage',
        path: targetPath,
        usedBytes,
      };
    } catch (error) {
      return {
        ...this.serviceError(error),
        provider: StorageProvider.LOCAL,
        scope: 'local-storage',
        path: targetPath,
        usedBytes: 0,
      };
    }
  }

  private async objectStorageUsage(setting: RuntimeStorageSetting) {
    try {
      const aggregate = await this.prisma.image.aggregate({
        _sum: { sizeBytes: true },
        where: {
          storageProvider: setting.storageProvider,
          status: { not: ImageStatus.DELETED },
        },
      });

      return {
        ...this.serviceOk(),
        provider: setting.storageProvider,
        scope: 'image-records',
        path: setting.s3Bucket?.trim() || 'object-storage',
        usedBytes: Number(aggregate._sum.sizeBytes ?? 0),
      };
    } catch (error) {
      return {
        ...this.serviceError(error),
        provider: setting.storageProvider,
        scope: 'image-records',
        path: setting.s3Bucket?.trim() || 'object-storage',
        usedBytes: 0,
      };
    }
  }

  private async directorySize(dir: string): Promise<number> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) return 0;
        if (entry.isDirectory()) return this.directorySize(fullPath);
        if (!entry.isFile()) return 0;
        const info = await stat(fullPath);
        return info.size;
      }),
    );

    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private localStoragePath(setting: RuntimeStorageSetting) {
    return (
      setting.localStoragePath?.trim() ||
      this.config.get<string>('LOCAL_STORAGE_PATH') ||
      path.resolve(process.cwd(), 'storage')
    );
  }

  private overallStatus(statuses: ServiceHealth[]) {
    if (statuses.some((item) => item.status === 'error')) {
      return 'degraded';
    }

    if (statuses.some((item) => item.status === 'warning')) {
      return 'warning';
    }

    return 'ok';
  }

  private serviceOk(): ServiceHealth {
    return { status: 'ok' };
  }

  private serviceWarning(message: string): ServiceHealth {
    return { status: 'warning', message };
  }

  private serviceError(error: unknown): ServiceHealth {
    return { status: 'error', message: errorMessage(error) };
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || '未知错误');
}
