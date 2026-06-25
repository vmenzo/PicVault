import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import sharp = require('sharp');
import { ImageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  StorageRuntimeConfig,
  StorageService,
} from '../storage/storage.service';

@Injectable()
@Processor('image-processing')
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {
    super();
  }

  async process(job: Job<{ imageId: string; storageKey: string }>) {
    this.logger.log(`Processing image ${job.data.imageId}`);

    const image = await this.prisma.image.findUnique({
      where: { id: job.data.imageId },
      select: {
        id: true,
        ownerId: true,
        storageProvider: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
      },
    });

    if (!image) {
      return { ok: false };
    }

    const generatedKeys: string[] = [];
    let cleanupSetting: StorageRuntimeConfig | undefined;
    let persisted = false;

    try {
      const setting = {
        ...(await this.settings.getRuntime(image.ownerId)),
        storageProvider: image.storageProvider,
      };
      cleanupSetting = setting;
      const input = await this.storage.getObjectBuffer(
        image.storageKey,
        setting,
      );
      const metadata = await sharp(input, { failOn: 'error' })
        .rotate()
        .metadata();
      const updates: {
        width?: number;
        height?: number;
        sizeBytes?: bigint;
        publicUrl?: string;
        thumbKey?: string;
        thumbUrl?: string;
        webpKey?: string;
        webpUrl?: string;
        avifKey?: string;
        avifUrl?: string;
        status: ImageStatus;
      } = {
        width: metadata.width,
        height: metadata.height,
        publicUrl: this.storage.getPublicUrlWithBase(image.storageKey, setting),
        status: ImageStatus.READY,
      };

      const stem = image.storageKey.replace(/\.[^.]+$/, '');
      const transformer = () =>
        this.applyImageOptions(
          sharp(input, { failOn: 'none' }).rotate(),
          setting,
        );

      if (this.shouldRewriteOriginal(image.mimeType, setting)) {
        const processed = await this.encodeOriginal(
          transformer(),
          image.mimeType,
        );
        if (processed) {
          await this.storage.putObject({
            key: image.storageKey,
            body: processed.data,
            contentType: image.mimeType,
            setting,
          });
          updates.width = processed.info.width;
          updates.height = processed.info.height;
          updates.sizeBytes = BigInt(processed.data.length);
        }
      }

      if (setting.generateThumbnail) {
        const thumbKey = `${stem}.thumb.webp`;
        const thumb = await transformer()
          .resize({
            width: 640,
            height: 640,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .toBuffer();

        await this.storage.putObject({
          key: thumbKey,
          body: thumb,
          contentType: 'image/webp',
          setting,
        });
        generatedKeys.push(thumbKey);
        updates.thumbKey = thumbKey;
        updates.thumbUrl = this.storage.getPublicUrlWithBase(thumbKey, setting);
      }

      if (setting.generateWebp) {
        const webpKey = `${stem}.webp`;
        const webp = await transformer().webp({ quality: 84 }).toBuffer();
        await this.storage.putObject({
          key: webpKey,
          body: webp,
          contentType: 'image/webp',
          setting,
        });
        generatedKeys.push(webpKey);
        updates.webpKey = webpKey;
        updates.webpUrl = this.storage.getPublicUrlWithBase(webpKey, setting);
      }

      if (setting.generateAvif) {
        const avifKey = `${stem}.avif`;
        const avif = await transformer().avif({ quality: 55 }).toBuffer();
        await this.storage.putObject({
          key: avifKey,
          body: avif,
          contentType: 'image/avif',
          setting,
        });
        generatedKeys.push(avifKey);
        updates.avifKey = avifKey;
        updates.avifUrl = this.storage.getPublicUrlWithBase(avifKey, setting);
      }

      await this.prisma.image.update({
        where: { id: image.id },
        data: updates,
      });
      persisted = true;

      if (
        updates.sizeBytes !== undefined &&
        updates.sizeBytes !== image.sizeBytes
      ) {
        const delta = updates.sizeBytes - image.sizeBytes;
        await this.prisma.user.update({
          where: { id: image.ownerId },
          data: {
            usedBytes: {
              increment: delta,
            },
          },
        });
      }

      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error);
      this.logger.error(
        `Failed to process image ${job.data.imageId}: ${message}`,
      );
      await this.prisma.image.update({
        where: { id: job.data.imageId },
        data: { status: ImageStatus.FAILED },
      });

      throw error;
    } finally {
      if (!persisted && cleanupSetting && generatedKeys.length) {
        await Promise.allSettled(
          generatedKeys.map((key) =>
            this.storage.deleteObject(key, cleanupSetting),
          ),
        );
      }
    }
  }

  private applyImageOptions(
    pipeline: sharp.Sharp,
    setting: {
      stripMetadata: boolean;
      watermark: boolean;
      watermarkText: string;
    },
  ) {
    const next = setting.stripMetadata ? pipeline : pipeline.withMetadata();

    if (!setting.watermark || !setting.watermarkText.trim()) {
      return next;
    }

    const text = setting.watermarkText.trim().slice(0, 80);
    const svg = Buffer.from(`
      <svg width="420" height="96" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="420" height="96" rx="14" fill="rgba(0,0,0,0.42)"/>
        <text x="24" y="58" font-size="34" font-family="Arial, sans-serif" fill="white">${this.escapeXml(text)}</text>
      </svg>
    `);

    return next.composite([
      {
        input: svg,
        gravity: 'southeast',
      },
    ]);
  }

  private shouldRewriteOriginal(
    mimeType: string,
    setting: {
      stripMetadata: boolean;
      watermark: boolean;
      watermarkText: string;
    },
  ) {
    if (mimeType === 'image/gif') {
      return false;
    }

    if (
      !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(
        mimeType,
      )
    ) {
      return false;
    }

    return (
      setting.stripMetadata ||
      (setting.watermark && !!setting.watermarkText.trim())
    );
  }

  private encodeOriginal(pipeline: sharp.Sharp, mimeType: string) {
    if (mimeType === 'image/jpeg') {
      return pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer({
        resolveWithObject: true,
      });
    }

    if (mimeType === 'image/png') {
      return pipeline.png({ compressionLevel: 9 }).toBuffer({
        resolveWithObject: true,
      });
    }

    if (mimeType === 'image/webp') {
      return pipeline.webp({ quality: 90 }).toBuffer({
        resolveWithObject: true,
      });
    }

    if (mimeType === 'image/avif') {
      return pipeline.avif({ quality: 65 }).toBuffer({
        resolveWithObject: true,
      });
    }

    return null;
  }

  private escapeXml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
