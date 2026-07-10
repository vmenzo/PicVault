import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ImageStatus, StorageProvider } from '@prisma/client';
import { Queue } from 'bullmq';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
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

type BackupSnapshot = {
  name: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
};

@Injectable()
export class MaintenanceService {
  private backupRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

  async backupStatus() {
    const backupDir = this.backupDirectory();
    return {
      running: this.backupRunning,
      directory: backupDir,
      latest: await this.latestBackup(backupDir),
    };
  }

  async runBackup(context: AuditContext) {
    if (this.backupRunning) {
      throw new ConflictException('Backup is already running');
    }

    this.backupRunning = true;
    const backupDir = this.backupDirectory();
    const stamp = this.backupStamp();
    const destination = path.join(backupDir, stamp);

    try {
      await mkdir(destination, { recursive: true });
      const postgresSql = path.join(destination, 'postgres.sql');
      await this.dumpPostgres(postgresSql);

      const storageArchive = await this.archiveLocalStorage(destination);
      await this.writeChecksums(destination);
      const snapshot = await this.writeBackupManifest(destination, {
        createdAt: new Date().toISOString(),
        postgresSql,
        storageArchive,
      });

      await this.pruneBackups(backupDir, 14);
      await this.audit.record(context, {
        action: 'maintenance.backup',
        target: 'backup',
        metadata: {
          name: snapshot.name,
          path: snapshot.path,
          sizeBytes: snapshot.sizeBytes,
          fileCount: snapshot.fileCount,
        },
      });

      return {
        ok: true,
        running: false,
        directory: backupDir,
        latest: snapshot,
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.backupRunning = false;
    }
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

    let affected = 0;
    if (images.length) {
      const result = await this.prisma.image.updateMany({
        where: {
          id: { in: images.map((image) => image.id) },
          status: dto.missingOnly
            ? ImageStatus.READY
            : { not: ImageStatus.DELETED },
          uploadedAt: { not: null },
        },
        data: { status: ImageStatus.PROCESSING },
      });
      affected = result.count;
      const queuedImages = affected
        ? await this.prisma.image.findMany({
            where: {
              id: { in: images.map((image) => image.id) },
              status: ImageStatus.PROCESSING,
              uploadedAt: { not: null },
            },
            select: { id: true, storageKey: true },
          })
        : [];

      await Promise.all(
        queuedImages.map((image) =>
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
        count: affected,
        missingOnly: Boolean(dto.missingOnly),
      },
    });

    return { affected };
  }

  async migrate(actorId: string, dto: MigrateImagesDto, context: AuditContext) {
    const images = await this.prisma.image.findMany({
      where: {
        status: { not: ImageStatus.DELETED },
        uploadedAt: { not: null },
        storageProvider: { not: dto.targetProvider },
        id: dto.imageIds?.length ? { in: dto.imageIds } : undefined,
      },
      select: {
        id: true,
        ownerId: true,
        storageProvider: true,
        storageKey: true,
        thumbKey: true,
        webpKey: true,
        avifKey: true,
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
        const reprocess = dto.reprocess ?? true;
        const migratedOne = await this.migrateOne(
          image,
          dto.targetProvider,
          reprocess,
        );
        if (!migratedOne) {
          continue;
        }
        migrated += 1;

        if (reprocess) {
          await this.processingQueue.add('process-image', {
            imageId: image.id,
            storageKey: image.storageKey,
          });
        }
      } catch {
        failed += 1;
        await this.prisma.image.updateMany({
          where: {
            id: image.id,
            status: { not: ImageStatus.DELETED },
          },
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
      thumbKey: string | null;
      webpKey: string | null;
      avifKey: string | null;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint;
    },
    targetProvider: StorageProvider,
    reprocess: boolean,
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

    const copiedKeys: string[] = [];
    await this.copyObjectToTarget({
      key: image.storageKey,
      contentType:
        image.mimeType ||
        lookup(image.originalName) ||
        'application/octet-stream',
      sourceSetting,
      targetSetting,
    });
    copiedKeys.push(image.storageKey);

    if (!reprocess) {
      for (const variant of [
        { key: image.thumbKey, contentType: 'image/webp' },
        { key: image.webpKey, contentType: 'image/webp' },
        { key: image.avifKey, contentType: 'image/avif' },
      ]) {
        if (!variant.key) {
          continue;
        }

        await this.copyObjectToTarget({
          key: variant.key,
          contentType: variant.contentType,
          sourceSetting,
          targetSetting,
        });
        copiedKeys.push(variant.key);
      }
    }

    const updated = await this.prisma.image.updateMany({
      where: {
        id: image.id,
        status: { not: ImageStatus.DELETED },
        uploadedAt: { not: null },
      },
      data: {
        storageProvider: targetSetting.storageProvider,
        publicUrl: this.storage.getPublicUrlWithBase(
          image.storageKey,
          targetSetting,
        ),
        ...(reprocess
          ? {
              thumbKey: null,
              thumbUrl: null,
              webpKey: null,
              webpUrl: null,
              avifKey: null,
              avifUrl: null,
              status: ImageStatus.PROCESSING,
            }
          : {}),
      },
    });

    if (updated.count !== 1) {
      await Promise.allSettled(
        copiedKeys.map((key) => this.storage.deleteObject(key, targetSetting)),
      );
      return false;
    }

    return true;
  }

  private async copyObjectToTarget(input: {
    key: string;
    contentType: string;
    sourceSetting: RuntimeUploadSetting & { storageProvider: StorageProvider };
    targetSetting: RuntimeUploadSetting & { storageProvider: StorageProvider };
  }) {
    const buffer = await this.storage.getObjectBuffer(
      input.key,
      input.sourceSetting,
    );

    await this.storage.putObject({
      key: input.key,
      body: buffer,
      contentType: input.contentType,
      setting: input.targetSetting,
    });
  }

  private backupDirectory() {
    return this.config.get<string>('PICVAULT_BACKUP_DIR') ?? '/app/backups';
  }

  private backupStamp() {
    const date = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join('');
  }

  private async latestBackup(backupDir: string) {
    try {
      await mkdir(backupDir, { recursive: true });
      const entries = await readdir(backupDir, { withFileTypes: true });
      const backups = (
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) =>
              this.backupSnapshot(path.join(backupDir, entry.name)),
            ),
        )
      ).filter(Boolean) as BackupSnapshot[];
      backups.sort((a, b) => b.name.localeCompare(a.name));
      return backups[0] ?? null;
    } catch {
      return null;
    }
  }

  private async backupSnapshot(dir: string): Promise<BackupSnapshot | null> {
    try {
      const files = await this.filesInDirectory(dir);
      const stats = await Promise.all(files.map((file) => stat(file)));
      const newestMtime = stats.reduce(
        (latest, item) => Math.max(latest, item.mtimeMs),
        0,
      );
      return {
        name: path.basename(dir),
        path: dir,
        sizeBytes: stats.reduce((sum, item) => sum + item.size, 0),
        fileCount: files.length,
        createdAt: new Date(newestMtime || Date.now()).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async filesInDirectory(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name));
  }

  private async dumpPostgres(outputPath: string) {
    const args = [
      '-h',
      this.config.get<string>('POSTGRES_HOST') ?? 'postgres',
      '-p',
      String(this.config.get<string | number>('POSTGRES_PORT') ?? 5432),
      '-U',
      this.config.get<string>('POSTGRES_USER') ?? 'picvault',
      this.config.get<string>('POSTGRES_DB') ?? 'picvault',
    ];

    await this.runProcess('pg_dump', args, {
      cwd: process.cwd(),
      outputPath,
      env: {
        ...process.env,
        PGPASSWORD: this.config.get<string>('POSTGRES_PASSWORD') ?? '',
      },
    });
  }

  private async archiveLocalStorage(destination: string) {
    const storageDir =
      this.config.get<string>('LOCAL_STORAGE_PATH') ??
      path.resolve(process.cwd(), 'backend/storage');
    try {
      const info = await stat(storageDir);
      if (!info.isDirectory()) return null;
    } catch {
      return null;
    }

    const archiveName = 'local-storage.tar.gz';
    await this.runProcess('tar', [
      '-C',
      storageDir,
      '-czf',
      path.join(destination, archiveName),
      '.',
    ]);
    return archiveName;
  }

  private async writeChecksums(destination: string) {
    const files = (await this.filesInDirectory(destination))
      .map((file) => path.basename(file))
      .filter((file) => file !== 'SHA256SUMS')
      .sort();
    if (!files.length) return;

    await this.runProcess('sha256sum', files, {
      cwd: destination,
      outputPath: path.join(destination, 'SHA256SUMS'),
    });
  }

  private async writeBackupManifest(
    destination: string,
    input: {
      createdAt: string;
      postgresSql: string;
      storageArchive: string | null;
    },
  ) {
    const postgresInfo = await stat(input.postgresSql);
    await writeFile(
      path.join(destination, 'manifest.json'),
      `${JSON.stringify(
        {
          createdAt: input.createdAt,
          path: destination,
          postgresSqlBytes: postgresInfo.size,
          localStorageArchive: input.storageArchive,
          retentionDays: 14,
          mode: 'manual',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const snapshot = await this.backupSnapshot(destination);
    if (!snapshot) {
      throw new InternalServerErrorException(
        'Backup manifest was written but snapshot could not be read',
      );
    }
    return snapshot;
  }

  private async pruneBackups(backupDir: string, retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = await readdir(backupDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(backupDir, entry.name);
          const info = await stat(fullPath);
          if (info.mtimeMs < cutoff) {
            await rm(fullPath, { recursive: true, force: true });
          }
        }),
    );
  }

  private runProcess(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      outputPath?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', options.outputPath ? 'pipe' : 'ignore', 'pipe'],
      });
      const output = options.outputPath
        ? createWriteStream(options.outputPath, { flags: 'w' })
        : null;
      let stderr = '';

      if (output && child.stdout) {
        child.stdout.pipe(output);
      }

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        output?.destroy();
        reject(
          new InternalServerErrorException(
            `${command} failed to start: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) {
          if (output) {
            output.on('finish', resolve);
            output.on('error', reject);
            output.end();
          } else {
            resolve();
          }
          return;
        }
        output?.destroy();
        reject(
          new InternalServerErrorException(
            `${command} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
      });
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
