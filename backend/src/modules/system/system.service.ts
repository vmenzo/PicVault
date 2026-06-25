import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { readdir, stat, statfs } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
    const queueCounts = await this.imageQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    const [users, images, albums, apiKeys, telegramEnabled, setting] =
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
        this.prisma.appSetting.findUnique({
          where: { ownerId },
          select: {
            storageProvider: true,
            publicBaseUrl: true,
            s3Endpoint: true,
            s3Bucket: true,
            localStoragePath: true,
          },
        }),
      ]);
    const storageProvider = setting?.storageProvider ?? StorageProvider.S3;
    const storageRoot =
      settingStorageRootCandidate(setting?.localStoragePath) ??
      settingStorageRootCandidate(
        this.config.get<string>('LOCAL_STORAGE_PATH'),
      ) ??
      process.cwd();
    const [disk, backup] = await Promise.all([
      this.diskUsage(storageRoot),
      this.latestBackup(),
    ]);
    const defaultPublicBaseUrl =
      storageProvider === StorageProvider.LOCAL ? '/api/public/files' : '';

    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      nodeVersion: process.version,
      memory: process.memoryUsage(),
      services: {
        database: 'ok',
        redis: {
          host: this.config.get<string>('REDIS_HOST') ?? 'localhost',
          port: this.config.get<number>('REDIS_PORT') ?? 6379,
        },
        storage: {
          provider: storageProvider,
          endpoint:
            storageProvider === StorageProvider.LOCAL
              ? (setting?.localStoragePath ??
                this.config.get<string>('LOCAL_STORAGE_PATH') ??
                'storage')
              : (setting?.s3Endpoint ??
                this.config.get<string>('S3_ENDPOINT') ??
                '未配置'),
          bucket:
            storageProvider === StorageProvider.LOCAL
              ? 'local'
              : (setting?.s3Bucket ??
                this.config.get<string>('S3_BUCKET') ??
                '未配置'),
          publicBaseUrl:
            setting?.publicBaseUrl ??
            this.config.get<string>('PUBLIC_IMAGE_BASE_URL') ??
            defaultPublicBaseUrl,
        },
        telegram: {
          enabledAccounts: telegramEnabled,
        },
        queue: queueCounts,
        disk,
        backup,
      },
      counts: {
        users,
        images,
        albums,
        apiKeys,
      },
    };
  }

  private async diskUsage(targetPath: string) {
    try {
      const info = await statfs(targetPath);
      return {
        path: targetPath,
        totalBytes: Number(info.blocks) * Number(info.bsize),
        freeBytes: Number(info.bavail) * Number(info.bsize),
        usedBytes: Number(info.blocks - info.bavail) * Number(info.bsize),
      };
    } catch {
      return {
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
        directory: backupDir,
        latest: backups[0] ?? null,
        count: backups.length,
      };
    } catch {
      return {
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
}

function settingStorageRootCandidate(value?: string | null) {
  return value?.trim() || null;
}
