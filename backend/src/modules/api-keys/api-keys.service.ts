import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { generateOpaqueToken } from '../../common/tokens';
import { PrismaService } from '../prisma/prisma.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });
  }

  async create(userId: string, dto: CreateApiKeyDto) {
    const key = generateOpaqueToken();
    const keyHash = this.hash(key);
    const record = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name,
        keyHash,
      },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return {
      ...record,
      key,
    };
  }

  async remove(userId: string, id: string) {
    await this.prisma.apiKey.deleteMany({
      where: {
        id,
        userId,
      },
    });
    return { ok: true };
  }

  async authenticate(key: string) {
    const record = await this.prisma.apiKey.findUnique({
      where: { keyHash: this.hash(key) },
      select: {
        id: true,
        user: {
          select: {
            id: true,
            publicId: true,
            email: true,
            role: true,
            disabled: true,
          },
        },
      },
    });

    if (!record || record.user.disabled) {
      return null;
    }

    await this.prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });

    return record.user;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
