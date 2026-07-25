import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageProvider } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requiredConfig } from '../../common/required-config';

export type StorageRuntimeConfig = {
  storageProvider?: StorageProvider;
  publicBaseUrl?: string | null;
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3Bucket?: string | null;
  s3AccessKey?: string | null;
  s3SecretKey?: string | null;
  s3ForcePathStyle?: boolean;
  localStoragePath?: string | null;
};

export type LocalUploadDraft = {
  tempPath: string;
  sizeBytes: number;
  commit: () => Promise<string>;
  cleanup: () => Promise<void>;
};

@Injectable()
export class StorageService implements OnModuleInit {
  private defaultBucket: string;
  private defaultPublicBaseUrl: string;
  private defaultLocalStoragePath: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.defaultBucket = this.config.get<string>('S3_BUCKET') ?? '';
    this.defaultPublicBaseUrl =
      this.config.get<string>('PUBLIC_IMAGE_BASE_URL') ?? '/api/public/files';
    this.defaultLocalStoragePath =
      this.config.get<string>('LOCAL_STORAGE_PATH') ??
      path.resolve(process.cwd(), 'storage');
  }

  getProvider(setting?: StorageRuntimeConfig) {
    return setting?.storageProvider ?? StorageProvider.LOCAL;
  }

  getPublicUrlWithBase(key: string, setting?: StorageRuntimeConfig) {
    const base =
      this.getProvider(setting) === StorageProvider.LOCAL
        ? '/api/public/files'
        : setting?.publicBaseUrl?.trim() || this.defaultPublicBaseUrl;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  async createUploadUrl(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    setting?: StorageRuntimeConfig;
  }) {
    if (this.getProvider(input.setting) === StorageProvider.S3) {
      this.ensureS3Ready(input.setting);
    }

    return `/api/upload/${encodeURIComponent(input.key)}/object`;
  }

  async getObjectBuffer(key: string, setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) === StorageProvider.LOCAL) {
      return readFile(this.getLocalPath(key, setting));
    }

    this.ensureS3Ready(setting);
    const result = await this.createS3Client(setting).send(
      new GetObjectCommand({
        Bucket: this.getBucket(setting),
        Key: key,
      }),
    );

    if (!result.Body) {
      return Buffer.alloc(0);
    }

    return this.streamToBuffer(result.Body as Readable);
  }

  createReadStream(key: string, setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) === StorageProvider.LOCAL) {
      return createReadStream(this.getLocalPath(key, setting));
    }

    return null;
  }

  async createReadStreamIfExists(key: string, setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) === StorageProvider.LOCAL) {
      const filePath = this.getLocalPath(key, setting);
      try {
        await access(filePath);
      } catch {
        return null;
      }

      return createReadStream(filePath);
    }

    try {
      const result = await this.createS3Client(setting).send(
        new GetObjectCommand({
          Bucket: this.getBucket(setting),
          Key: key,
        }),
      );

      if (!result.Body) {
        return null;
      }

      return result.Body as Readable;
    } catch {
      return null;
    }
  }

  async putObject(input: {
    key: string;
    body: Buffer | Readable;
    contentType: string;
    contentLength?: number;
    cacheControl?: string;
    setting?: StorageRuntimeConfig;
  }) {
    if (this.getProvider(input.setting) === StorageProvider.LOCAL) {
      const filePath = this.getLocalPath(input.key, input.setting);
      await mkdir(path.dirname(filePath), { recursive: true });
      if (Buffer.isBuffer(input.body)) {
        await writeFile(filePath, input.body);
      } else {
        await pipeline(input.body, createWriteStream(filePath));
      }
      return this.getPublicUrlWithBase(input.key, input.setting);
    }

    this.ensureS3Ready(input.setting);
    await this.createS3Client(input.setting).send(
      new PutObjectCommand({
        Bucket: this.getBucket(input.setting),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength:
          input.contentLength ??
          (Buffer.isBuffer(input.body) ? input.body.length : undefined),
        CacheControl: input.cacheControl ?? 'public, max-age=300',
      }),
    );

    return this.getPublicUrlWithBase(input.key, input.setting);
  }

  async createUploadDraft(input: {
    key: string;
    body: AsyncIterable<Buffer | Uint8Array | string>;
    expectedSizeBytes: number;
    contentType: string;
    setting?: StorageRuntimeConfig;
  }): Promise<LocalUploadDraft> {
    const provider = this.getProvider(input.setting);
    if (provider === StorageProvider.S3) {
      this.ensureS3Ready(input.setting);
    }
    const finalPath =
      provider === StorageProvider.LOCAL
        ? this.getLocalPath(input.key, input.setting)
        : null;
    const tempDir = finalPath
      ? path.join(path.dirname(finalPath), '.tmp')
      : path.join(tmpdir(), 'picvault-uploads');
    await mkdir(tempDir, { recursive: true });

    const tempPath = path.join(
      tempDir,
      `${path.basename(finalPath ?? input.key)}.${randomUUID()}.upload`,
    );
    let sizeBytes = 0;

    const counter = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.length;

        if (sizeBytes > input.expectedSizeBytes) {
          callback(
            new BadRequestException('Uploaded object size does not match'),
          );
          return;
        }

        callback(null, buffer);
      },
    });

    try {
      await pipeline(
        Readable.from(input.body),
        counter,
        createWriteStream(tempPath, { flags: 'wx' }),
      );
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    if (sizeBytes !== input.expectedSizeBytes) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new BadRequestException('Uploaded object size does not match');
    }

    return {
      tempPath,
      sizeBytes,
      commit: async () => {
        if (finalPath) {
          await mkdir(path.dirname(finalPath), { recursive: true });
          await rename(tempPath, finalPath);
          return this.getPublicUrlWithBase(input.key, input.setting);
        }

        try {
          await this.putObject({
            key: input.key,
            body: createReadStream(tempPath),
            contentType: input.contentType,
            contentLength: sizeBytes,
            setting: input.setting,
          });
        } finally {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }

        return this.getPublicUrlWithBase(input.key, input.setting);
      },
      cleanup: () => rm(tempPath, { force: true }).then(() => undefined),
    };
  }

  async deleteObject(key: string, setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) === StorageProvider.LOCAL) {
      await rm(this.getLocalPath(key, setting), { force: true });
      return;
    }

    this.ensureS3Ready(setting);
    await this.createS3Client(setting).send(
      new DeleteObjectCommand({
        Bucket: this.getBucket(setting),
        Key: key,
      }),
    );
  }

  getObjectUrlPath(key: string) {
    return `/api/public/files/${encodeURIComponent(key)}`;
  }

  getLocalObjectPath(key: string, setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) !== StorageProvider.LOCAL) {
      throw new BadRequestException(
        'Image is not configured for local storage',
      );
    }

    return this.getLocalPath(key, setting);
  }

  async testS3Connection(setting?: StorageRuntimeConfig) {
    const s3Setting: StorageRuntimeConfig = {
      ...(setting ?? {}),
      storageProvider: StorageProvider.S3,
    };
    this.ensureS3Ready(s3Setting);
    await this.createS3Client(s3Setting).send(
      new HeadBucketCommand({
        Bucket: this.getBucket(s3Setting),
      }),
    );
  }

  async testLocalStorage(setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) !== StorageProvider.LOCAL) {
      throw new BadRequestException(
        'Image is not configured for local storage',
      );
    }

    const root = this.getLocalRoot(setting);
    await mkdir(root, { recursive: true });
    await access(root, constants.R_OK | constants.W_OK);

    const probePath = path.join(root, `.picvault-write-test-${randomUUID()}`);
    await writeFile(probePath, '');
    await rm(probePath, { force: true });

    return root;
  }

  private createS3Client(setting?: StorageRuntimeConfig) {
    return new S3Client({
      endpoint:
        setting?.s3Endpoint?.trim() || this.config.get<string>('S3_ENDPOINT'),
      region:
        setting?.s3Region?.trim() ||
        this.config.get<string>('S3_REGION') ||
        'us-east-1',
      credentials: {
        accessKeyId:
          setting?.s3AccessKey?.trim() ||
          requiredConfig(this.config, 'S3_ACCESS_KEY'),
        secretAccessKey:
          setting?.s3SecretKey?.trim() ||
          requiredConfig(this.config, 'S3_SECRET_KEY'),
      },
      forcePathStyle:
        setting?.s3ForcePathStyle ??
        (this.config.get<string>('S3_FORCE_PATH_STYLE') ?? 'true') === 'true',
    });
  }

  private getBucket(setting?: StorageRuntimeConfig) {
    return setting?.s3Bucket?.trim() || this.defaultBucket;
  }

  private ensureS3Ready(setting?: StorageRuntimeConfig) {
    if (this.getProvider(setting) !== StorageProvider.S3) {
      return;
    }

    const missing = [
      this.getBucket(setting) ? null : 'Bucket',
      setting?.s3Endpoint?.trim() || this.config.get<string>('S3_ENDPOINT')
        ? null
        : 'Endpoint',
      setting?.s3AccessKey?.trim() || this.config.get<string>('S3_ACCESS_KEY')
        ? null
        : 'Access Key',
      setting?.s3SecretKey?.trim() || this.config.get<string>('S3_SECRET_KEY')
        ? null
        : 'Secret Key',
    ].filter(Boolean);

    if (missing.length) {
      throw new BadRequestException(
        `Third-party object storage is not configured: ${missing.join(', ')}`,
      );
    }
  }

  private getLocalPath(key: string, setting?: StorageRuntimeConfig) {
    const root = this.getLocalRoot(setting);
    const filePath = path.resolve(root, key);

    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Invalid storage key');
    }

    return filePath;
  }

  private getLocalRoot(setting?: StorageRuntimeConfig) {
    return path.resolve(
      setting?.localStoragePath?.trim() || this.defaultLocalStoragePath,
    );
  }

  private async streamToBuffer(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
