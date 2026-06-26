import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageProvider } from '@prisma/client';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'stream';
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

@Injectable()
export class StorageService implements OnModuleInit {
  private defaultBucket: string;
  private defaultPublicBaseUrl: string;
  private defaultUploadEndpoint: string;
  private defaultLocalStoragePath: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.defaultBucket = this.config.get<string>('S3_BUCKET') ?? '';
    this.defaultPublicBaseUrl =
      this.config.get<string>('PUBLIC_IMAGE_BASE_URL') ?? '/api/public/files';
    this.defaultUploadEndpoint =
      this.config.get<string>('S3_UPLOAD_ENDPOINT') ||
      this.config.get<string>('S3_ENDPOINT') ||
      '';
    this.defaultLocalStoragePath =
      this.config.get<string>('LOCAL_STORAGE_PATH') ??
      path.resolve(process.cwd(), 'storage');
  }

  getProvider(setting?: StorageRuntimeConfig) {
    return setting?.storageProvider ?? StorageProvider.S3;
  }

  getPublicUrlWithBase(key: string, setting?: StorageRuntimeConfig) {
    const base =
      setting?.publicBaseUrl?.trim() ||
      (this.getProvider(setting) === StorageProvider.LOCAL
        ? '/api/public/files'
        : this.defaultPublicBaseUrl);
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  async createUploadUrl(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    setting?: StorageRuntimeConfig;
  }) {
    if (this.getProvider(input.setting) === StorageProvider.LOCAL) {
      return `/api/upload/${encodeURIComponent(input.key)}/object`;
    }

    this.ensureS3Ready(input.setting);
    const command = new PutObjectCommand({
      Bucket: this.getBucket(input.setting),
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    });

    const signed = await getSignedUrl(
      this.createS3Client(input.setting),
      command,
      {
        expiresIn: 900,
      },
    );
    return this.rewriteSignedUrl(signed, input.setting);
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
    body: Buffer;
    contentType: string;
    cacheControl?: string;
    setting?: StorageRuntimeConfig;
  }) {
    if (this.getProvider(input.setting) === StorageProvider.LOCAL) {
      const filePath = this.getLocalPath(input.key, input.setting);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, input.body);
      return this.getPublicUrlWithBase(input.key, input.setting);
    }

    this.ensureS3Ready(input.setting);
    await this.createS3Client(input.setting).send(
      new PutObjectCommand({
        Bucket: this.getBucket(input.setting),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl:
          input.cacheControl ?? 'public, max-age=31536000, immutable',
      }),
    );

    return this.getPublicUrlWithBase(input.key, input.setting);
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

  async testS3Connection(setting?: StorageRuntimeConfig) {
    this.ensureS3Ready(setting);
    await this.createS3Client(setting).send(
      new HeadBucketCommand({
        Bucket: this.getBucket(setting),
      }),
    );
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

  private rewriteSignedUrl(url: string, setting?: StorageRuntimeConfig) {
    const endpoint =
      setting?.s3Endpoint?.trim() ||
      this.config.get<string>('S3_ENDPOINT') ||
      '';
    const publicEndpoint =
      this.config.get<string>('S3_UPLOAD_ENDPOINT')?.trim() || endpoint;

    if (publicEndpoint === endpoint) {
      return url;
    }

    try {
      const signed = new URL(url);
      const source = new URL(endpoint);

      if (signed.origin !== source.origin) {
        return url;
      }

      if (publicEndpoint.startsWith('/')) {
        const targetPath = publicEndpoint.replace(/\/$/, '');
        if (targetPath && !signed.pathname.startsWith(`${targetPath}/`)) {
          signed.pathname = `${targetPath}${signed.pathname}`;
        }

        return `${signed.pathname}${signed.search}${signed.hash}`;
      }

      const target = new URL(publicEndpoint);
      signed.protocol = target.protocol;
      signed.host = target.host;
      const targetPath = target.pathname.replace(/\/$/, '');
      if (targetPath && !signed.pathname.startsWith(`${targetPath}/`)) {
        signed.pathname = `${targetPath}${signed.pathname}`;
      }
      return signed.toString();
    } catch {
      return url;
    }
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
    const root = path.resolve(
      setting?.localStoragePath?.trim() || this.defaultLocalStoragePath,
    );
    const filePath = path.resolve(root, key);

    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Invalid storage key');
    }

    return filePath;
  }

  private async streamToBuffer(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
