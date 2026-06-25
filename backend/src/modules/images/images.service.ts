import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ImageStatus,
  Prisma,
  StorageProvider,
  Visibility,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { lookup } from 'mime-types';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StorageRuntimeConfig } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import {
  BulkImageAction,
  BulkImageActionDto,
} from './dto/bulk-image-action.dto';
import { ListImagesDto } from './dto/list-images.dto';
import { UpdateImageDto } from './dto/update-image.dto';

@Injectable()
export class ImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    @InjectQueue('image-processing')
    private readonly processingQueue: Queue,
  ) {}

  async list(ownerId: string, query: ListImagesDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 24;
    const sortBy = query.sortBy ?? 'createdAt';
    const sortOrder = query.sortOrder ?? 'desc';
    const where: Prisma.ImageWhereInput = {
      ownerId,
      status: query.status ?? { not: ImageStatus.DELETED },
      albumId: query.albumId,
      visibility: query.visibility,
      favorite: query.favorite,
      tags: query.tag ? { has: query.tag } : undefined,
      OR: query.q
        ? [
            { title: { contains: query.q, mode: 'insensitive' } },
            { originalName: { contains: query.q, mode: 'insensitive' } },
            { tags: { has: query.q } },
          ]
        : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.image.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          album: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.image.count({ where }),
    ]);

    return {
      items: items.map(this.serializeImage),
      total,
      page,
      pageSize,
    };
  }

  async stats(ownerId: string) {
    const [total, ready, pending, failed, deleted, albums, images, user] =
      await this.prisma.$transaction([
        this.prisma.image.count({
          where: { ownerId, status: { not: ImageStatus.DELETED } },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.READY },
        }),
        this.prisma.image.count({
          where: {
            ownerId,
            status: { in: [ImageStatus.PENDING, ImageStatus.PROCESSING] },
          },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.FAILED },
        }),
        this.prisma.image.count({
          where: { ownerId, status: ImageStatus.DELETED },
        }),
        this.prisma.album.count({ where: { ownerId } }),
        this.prisma.image.findMany({
          where: { ownerId, status: { not: ImageStatus.DELETED } },
          select: { sizeBytes: true },
        }),
        this.prisma.user.findUniqueOrThrow({
          where: { id: ownerId },
          select: { quotaBytes: true, usedBytes: true },
        }),
      ]);

    const calculatedUsedBytes = images.reduce(
      (sum, image) => sum + Number(image.sizeBytes),
      0,
    );
    const usedBytes = Number(user.usedBytes) || calculatedUsedBytes;

    return {
      total,
      ready,
      pending,
      failed,
      deleted,
      albums,
      usedBytes,
      quotaBytes: Number(user.quotaBytes),
    };
  }

  async update(ownerId: string, id: string, dto: UpdateImageDto) {
    await this.ensureOwner(ownerId, id);

    if (dto.albumId) {
      const album = await this.prisma.album.findFirst({
        where: {
          id: dto.albumId,
          ownerId,
        },
      });

      if (!album) {
        throw new ForbiddenException('Album is not accessible');
      }
    }

    const image = await this.prisma.image.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        tags: dto.tags,
        favorite: dto.favorite,
        visibility: dto.visibility,
        albumId: dto.albumId,
      },
      include: {
        album: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return this.serializeImage(image);
  }

  async remove(ownerId: string, id: string) {
    await this.ensureOwner(ownerId, id);
    await this.prisma.image.update({
      where: { id },
      data: {
        status: ImageStatus.DELETED,
      },
    });
    return { ok: true };
  }

  async tags(ownerId: string) {
    const images = await this.prisma.image.findMany({
      where: { ownerId, status: { not: ImageStatus.DELETED } },
      select: { tags: true },
    });
    const counts = new Map<string, number>();

    for (const image of images) {
      for (const tag of image.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  async restore(ownerId: string, id: string) {
    await this.ensureOwner(ownerId, id);
    const image = await this.prisma.image.update({
      where: { id },
      data: {
        status: ImageStatus.READY,
      },
      include: {
        album: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return this.serializeImage(image);
  }

  async permanentRemove(ownerId: string, id: string) {
    await this.ensureOwner(ownerId, id);
    await this.permanentlyDelete(ownerId, [id]);
    return { ok: true };
  }

  async bulk(ownerId: string, dto: BulkImageActionDto) {
    if (dto.action === BulkImageAction.MOVE_ALBUM && dto.albumId) {
      await this.ensureAlbum(ownerId, dto.albumId);
    }

    if (dto.action === BulkImageAction.SET_VISIBILITY && !dto.visibility) {
      throw new ForbiddenException('Visibility is required');
    }

    if (
      dto.action === BulkImageAction.SET_FAVORITE &&
      dto.favorite === undefined
    ) {
      throw new ForbiddenException('Favorite is required');
    }

    if (
      [BulkImageAction.ADD_TAGS, BulkImageAction.REMOVE_TAGS].includes(
        dto.action,
      ) &&
      !dto.tags?.length
    ) {
      throw new ForbiddenException('Tags are required');
    }

    const where = {
      ownerId,
      id: { in: dto.ids },
    };

    if (dto.action === BulkImageAction.DELETE) {
      const result = await this.prisma.image.updateMany({
        where,
        data: { status: ImageStatus.DELETED },
      });
      return { affected: result.count };
    }

    if (dto.action === BulkImageAction.RESTORE) {
      const result = await this.prisma.image.updateMany({
        where,
        data: { status: ImageStatus.READY },
      });
      return { affected: result.count };
    }

    if (dto.action === BulkImageAction.SET_VISIBILITY) {
      const result = await this.prisma.image.updateMany({
        where,
        data: { visibility: dto.visibility },
      });
      return { affected: result.count };
    }

    if (dto.action === BulkImageAction.MOVE_ALBUM) {
      const result = await this.prisma.image.updateMany({
        where,
        data: { albumId: dto.albumId || null },
      });
      return { affected: result.count };
    }

    if (dto.action === BulkImageAction.SET_FAVORITE) {
      const result = await this.prisma.image.updateMany({
        where,
        data: { favorite: dto.favorite },
      });
      return { affected: result.count };
    }

    if (dto.action === BulkImageAction.ADD_TAGS) {
      const images = await this.prisma.image.findMany({
        where,
        select: { id: true, tags: true },
      });

      await this.prisma.$transaction(
        images.map((image) =>
          this.prisma.image.update({
            where: { id: image.id },
            data: {
              tags: [...new Set([...image.tags, ...(dto.tags ?? [])])],
            },
          }),
        ),
      );

      return { affected: images.length };
    }

    if (dto.action === BulkImageAction.REMOVE_TAGS) {
      const removeSet = new Set(dto.tags ?? []);
      const images = await this.prisma.image.findMany({
        where,
        select: { id: true, tags: true },
      });

      await this.prisma.$transaction(
        images.map((image) =>
          this.prisma.image.update({
            where: { id: image.id },
            data: {
              tags: image.tags.filter((tag) => !removeSet.has(tag)),
            },
          }),
        ),
      );

      return { affected: images.length };
    }

    if (dto.action === BulkImageAction.REPROCESS) {
      const images = await this.prisma.image.findMany({
        where,
        select: { id: true, storageKey: true },
      });

      await this.prisma.image.updateMany({
        where,
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

      return { affected: images.length };
    }

    if (dto.action === BulkImageAction.PERMANENT_DELETE) {
      return this.permanentlyDelete(ownerId, dto.ids);
    }

    return { affected: 0 };
  }

  private async permanentlyDelete(ownerId: string, ids: string[]) {
    const images = await this.prisma.image.findMany({
      where: {
        ownerId,
        id: { in: ids },
      },
      select: {
        id: true,
        sizeBytes: true,
        storageProvider: true,
        storageKey: true,
        thumbKey: true,
        webpKey: true,
        avifKey: true,
      },
    });

    const releasedBytes = images.reduce(
      (sum, image) => sum + image.sizeBytes,
      BigInt(0),
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { usedBytes: true },
    });

    await this.prisma.$transaction([
      this.prisma.image.deleteMany({
        where: {
          ownerId,
          id: { in: images.map((image) => image.id) },
        },
      }),
      this.prisma.user.update({
        where: { id: ownerId },
        data: {
          usedBytes:
            user.usedBytes > releasedBytes ? user.usedBytes - releasedBytes : 0,
        },
      }),
    ]);

    await Promise.allSettled(
      images.flatMap((image) =>
        [image.storageKey, image.thumbKey, image.webpKey, image.avifKey]
          .filter(Boolean)
          .map(async (key) =>
            this.storage.deleteObject(
              key as string,
              await this.getImageStorageSetting(ownerId, image.storageProvider),
            ),
          ),
      ),
    );

    return { affected: images.length };
  }

  async reprocess(ownerId: string, id: string) {
    const image = await this.prisma.image.findFirst({
      where: {
        id,
        ownerId,
      },
      select: {
        id: true,
        storageKey: true,
      },
    });

    if (!image) {
      throw new ForbiddenException('Image is not accessible');
    }

    await this.prisma.image.update({
      where: { id },
      data: { status: ImageStatus.PROCESSING },
    });

    await this.processingQueue.add('process-image', {
      imageId: image.id,
      storageKey: image.storageKey,
    });

    return { ok: true };
  }

  async publicInfo(id: string) {
    const image = await this.prisma.image.findUnique({
      where: { id },
      include: {
        album: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (
      !image ||
      image.status !== ImageStatus.READY ||
      image.visibility === Visibility.PRIVATE
    ) {
      throw new NotFoundException('Image not found');
    }

    await this.prisma.image.update({
      where: { id },
      data: {
        views: {
          increment: 1,
        },
      },
    });

    return this.serializeImage({
      ...image,
      views: image.views + 1,
    });
  }

  async download(id: string) {
    const image = await this.prisma.image.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        originalName: true,
        status: true,
        visibility: true,
        ownerId: true,
        storageKey: true,
        storageProvider: true,
        mimeType: true,
      },
    });

    if (
      !image ||
      image.status !== ImageStatus.READY ||
      image.visibility === Visibility.PRIVATE
    ) {
      throw new NotFoundException('Image not found');
    }

    await this.prisma.image.update({
      where: { id },
      data: {
        downloads: {
          increment: 1,
        },
      },
    });

    return {
      filename: image.originalName || image.title,
      contentType: image.mimeType,
      buffer: await this.storage.getObjectBuffer(
        image.storageKey,
        await this.getImageStorageSetting(image.ownerId, image.storageProvider),
      ),
    };
  }

  async asset(ownerId: string, id: string, variant?: string) {
    const image = await this.prisma.image.findFirst({
      where: {
        id,
        ownerId,
      },
      select: {
        id: true,
        title: true,
        originalName: true,
        ownerId: true,
        storageProvider: true,
        storageKey: true,
        thumbKey: true,
        webpKey: true,
        avifKey: true,
        mimeType: true,
      },
    });

    if (!image) {
      throw new ForbiddenException('Image is not accessible');
    }

    const selected = this.selectAssetKey(image, variant);
    if (!selected.key) {
      throw new NotFoundException('Image asset not found');
    }

    const setting = await this.getImageStorageSetting(
      image.ownerId,
      image.storageProvider,
    );
    const stream = await this.storage.createReadStreamIfExists(
      selected.key,
      setting,
    );
    let buffer: Buffer | undefined;
    if (!stream) {
      try {
        buffer = await this.storage.getObjectBuffer(selected.key, setting);
      } catch {
        throw new NotFoundException('Image asset not found');
      }
    }

    return {
      filename: image.originalName || image.title,
      contentType:
        selected.contentType ||
        lookup(selected.key) ||
        'application/octet-stream',
      stream,
      buffer,
    };
  }

  private async ensureAlbum(ownerId: string, albumId: string) {
    const album = await this.prisma.album.findFirst({
      where: {
        id: albumId,
        ownerId,
      },
    });

    if (!album) {
      throw new ForbiddenException('Album is not accessible');
    }
  }

  private async ensureOwner(ownerId: string, id: string) {
    const image = await this.prisma.image.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!image || image.ownerId !== ownerId) {
      throw new ForbiddenException('Image is not accessible');
    }
  }

  private serializeImage<T extends { sizeBytes: bigint }>(image: T) {
    return {
      ...image,
      sizeBytes: Number(image.sizeBytes),
    };
  }

  private selectAssetKey(
    image: {
      storageKey: string;
      thumbKey: string | null;
      webpKey: string | null;
      avifKey: string | null;
      mimeType: string;
    },
    variant?: string,
  ) {
    if (!variant || variant === 'thumb') {
      return {
        key: image.thumbKey ?? image.storageKey,
        contentType: image.thumbKey ? 'image/webp' : image.mimeType,
      };
    }

    if (variant === 'original') {
      return { key: image.storageKey, contentType: image.mimeType };
    }

    if (variant === 'webp') {
      return { key: image.webpKey, contentType: 'image/webp' };
    }

    if (variant === 'avif') {
      return { key: image.avifKey, contentType: 'image/avif' };
    }

    throw new BadRequestException('Invalid image asset variant');
  }

  private async getImageStorageSetting(
    ownerId: string,
    storageProvider: StorageProvider,
  ): Promise<StorageRuntimeConfig> {
    return this.toStorageSetting({
      ...(await this.settings.getRuntime(ownerId)),
      storageProvider,
    });
  }

  private toStorageSetting(
    setting: StorageRuntimeConfig,
  ): StorageRuntimeConfig {
    return {
      storageProvider: setting.storageProvider,
      publicBaseUrl: setting.publicBaseUrl,
      s3Endpoint: setting.s3Endpoint,
      s3Region: setting.s3Region,
      s3Bucket: setting.s3Bucket,
      s3AccessKey: setting.s3AccessKey,
      s3SecretKey: setting.s3SecretKey,
      s3ForcePathStyle: setting.s3ForcePathStyle,
      localStoragePath: setting.localStoragePath,
    };
  }
}
