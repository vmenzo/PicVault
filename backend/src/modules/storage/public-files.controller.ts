import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Req,
  Res,
  StreamableFile,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ImageStatus, StorageProvider, Visibility } from '@prisma/client';
import { lookup } from 'mime-types';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageRuntimeConfig, StorageService } from './storage.service';

@Controller('public/files')
export class PublicFilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => SettingsService))
    private readonly settings: SettingsService,
  ) {}

  @Get('*path')
  async file(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = this.getKey(request);

    if (!key.startsWith('users/')) {
      throw new NotFoundException('File not found');
    }

    const image = await this.ensurePublicFile(key);
    const setting = await this.settings.getRuntime(image.ownerId);
    this.enforceHotlinkProtection(request, setting);

    const storageSetting: StorageRuntimeConfig = {
      ...setting,
      storageProvider: StorageProvider.LOCAL,
    };
    const stream = await this.storage.createReadStreamIfExists(
      key,
      storageSetting,
    );

    if (!stream) {
      throw new NotFoundException('File not found');
    }

    response.set({
      'Content-Type': lookup(key) || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });

    return new StreamableFile(stream);
  }

  private async ensurePublicFile(key: string) {
    const image = await this.prisma.image.findFirst({
      where: {
        OR: [
          { storageKey: key },
          { thumbKey: key },
          { webpKey: key },
          { avifKey: key },
        ],
      },
      select: {
        id: true,
        ownerId: true,
        status: true,
        visibility: true,
      },
    });

    if (
      !image ||
      image.status !== ImageStatus.READY ||
      image.visibility === Visibility.PRIVATE
    ) {
      throw new NotFoundException('File not found');
    }

    return image;
  }

  private enforceHotlinkProtection(
    request: Request,
    setting: Awaited<ReturnType<SettingsService['getRuntime']>>,
  ) {
    if (!setting.hotlinkProtection) {
      return;
    }

    const source = request.get('referer') || request.get('origin');
    if (!source) {
      return;
    }

    const requestOrigin = `${request.protocol}://${request.get('host')}`;
    const allowedOrigins = new Set([requestOrigin]);
    if (setting.publicBaseUrl) {
      try {
        allowedOrigins.add(new URL(setting.publicBaseUrl).origin);
      } catch {
        // Invalid publicBaseUrl is handled by settings validation on write.
      }
    }

    try {
      if (!allowedOrigins.has(new URL(source).origin)) {
        throw new ForbiddenException('Hotlink is not allowed');
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new ForbiddenException('Hotlink is not allowed');
    }
  }

  private getKey(request: Request) {
    const params = request.params as Record<
      string,
      string | string[] | undefined
    >;
    const raw = params.path ?? params[0] ?? request.url.replace(/^\//, '');
    const key = Array.isArray(raw) ? raw.join('/') : String(raw);

    try {
      return decodeURIComponent(key);
    } catch {
      return key;
    }
  }
}
