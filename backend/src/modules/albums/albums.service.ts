import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAlbumDto } from './dto/create-album.dto';
import { UpdateAlbumDto } from './dto/update-album.dto';

@Injectable()
export class AlbumsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerId: string) {
    const albums = await this.prisma.album.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { images: true },
        },
      },
    });

    return albums.map((album) => this.serializeAlbum(album));
  }

  private serializeAlbum(album: {
    _count: { images: number };
    [key: string]: unknown;
  }) {
    const { _count, ...rest } = album;
    return {
      ...rest,
      imageCount: _count.images,
    };
  }

  async create(ownerId: string, dto: CreateAlbumDto) {
    const album = await this.prisma.album.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        visibility: dto.visibility,
      },
      include: {
        _count: {
          select: { images: true },
        },
      },
    });

    return this.serializeAlbum(album);
  }

  async update(ownerId: string, id: string, dto: UpdateAlbumDto) {
    await this.ensureOwner(ownerId, id);
    const album = await this.prisma.album.update({
      where: { id },
      data: dto,
      include: {
        _count: {
          select: { images: true },
        },
      },
    });

    return this.serializeAlbum(album);
  }

  async remove(ownerId: string, id: string) {
    await this.ensureOwner(ownerId, id);
    await this.prisma.album.delete({
      where: { id },
    });
    return { ok: true };
  }

  private async ensureOwner(ownerId: string, id: string) {
    const album = await this.prisma.album.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!album || album.ownerId !== ownerId) {
      throw new ForbiddenException('Album is not accessible');
    }
  }
}
