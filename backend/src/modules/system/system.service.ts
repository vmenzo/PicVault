import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { constants } from 'node:fs';
import { access, mkdir, readdir, stat, statfs } from 'node:fs/promises';
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
    const diskPath =
      runtime.setting.storageProvider === StorageProvider.LOCAL
        ? this.localStoragePath(runtime.setting)
        : process.cwd();
    const [disk, backup] = await Promise.all([
      this.diskUsage(diskPath),
      this.latestBackup(),
    ]);
    const statuses = [
      database.database,
      queueServices.redis,
      queueServices.queue,
      storage,
      disk,
      backup,
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
        backup,
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

  private async diskUsage(targetPath: string) {
    try {
      const info = await statfs(targetPath);
      const totalBytes = Number(info.blocks) * Number(info.bsize);
      const freeBytes = Number(info.bavail) * Number(info.bsize);
      const usedBytes = Number(info.blocks - info.bavail) * Number(info.bsize);
      const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
      const health =
        freeRatio < 0.05
          ? this.serviceError('磁盘可用空间低于 5%')
          : freeRatio < 0.15
            ? this.serviceWarning('磁盘可用空间低于 15%')
            : this.serviceOk();

      return {
        ...health,
        path: targetPath,
        totalBytes,
        freeBytes,
        usedBytes,
      };
    } catch (error) {
      return {
        ...this.serviceError(error),
        path: targetPath,
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
      };
    }
  }

  private async latestBackup() {
    const backupDir =
      this.config.get<string>('PICVAULT_BACKUP_DIR') ?? '/app/backups';

    try {
      const entries = await readdir(backupDir, { withFileTypes: true });
      const directories = entries.filter((entry) => entry.isDirectory());
      const backups = await Promise.all(
        directories.map(async (entry) => {
          const fullPath = path.join(backupDir, entry.name);
          const files = await this.backupFiles(fullPath);
          const sizeBytes = files.reduce(
            (sum, file) => sum + file.sizeBytes,
            0,
          );
          const newestMtime = files.reduce(
            (latest, file) => Math.max(latest, file.mtimeMs),
            0,
          );

          return {
            name: entry.name,
            path: fullPath,
            sizeBytes,
            fileCount: files.length,
            createdAt: new Date(newestMtime || Date.now()).toISOString(),
          };
        }),
      );

      backups.sort((a, b) => b.name.localeCompare(a.name));
      return {
        ...(backups.length
          ? this.serviceOk()
          : this.serviceWarning('暂无备份')),
        directory: backupDir,
        latest: backups[0] ?? null,
        count: backups.length,
      };
    } catch (error) {
      return {
        ...this.serviceError(error),
        directory: backupDir,
        latest: null,
        count: 0,
      };
    }
  }

  private async backupFiles(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          const info = await stat(fullPath);
          return {
            sizeBytes: info.size,
            mtimeMs: info.mtimeMs,
          };
        }),
    );
    return files;
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
