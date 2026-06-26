import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { formatUserPublicId } from '../../common/public-id';
import { AuditContext, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ResetUserPasswordDto,
  UpdateUserAdminDto,
} from './dto/update-user-admin.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    role?: UserRole;
    disabled?: boolean;
  }) {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const where: Prisma.UserWhereInput = {
      role: query.role,
      disabled: query.disabled,
      OR: query.q
        ? [
            { email: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          publicId: true,
          email: true,
          name: true,
          role: true,
          disabled: true,
          quotaBytes: true,
          usedBytes: true,
          lastLoginAt: true,
          createdAt: true,
          _count: {
            select: {
              images: true,
              albums: true,
              apiKeys: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => ({
        ...user,
        publicId: formatUserPublicId(user.publicId),
        quotaBytes: Number(user.quotaBytes),
        usedBytes: Number(user.usedBytes),
        imageCount: user._count.images,
        albumCount: user._count.albums,
        apiKeyCount: user._count.apiKeys,
        _count: undefined,
      })),
      total,
      page,
      pageSize,
    };
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateUserAdminDto,
    auditContext: AuditContext,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (actorId === id && dto.disabled) {
      throw new ForbiddenException('You cannot disable your own account');
    }

    if (actorId === id && dto.role && dto.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You cannot remove your own admin role');
    }

    const email = dto.email?.toLowerCase().trim();

    if (email && email !== user.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException('Email is already registered');
      }
    }

    const updated = await this.prisma.user
      .update({
        where: { id },
        data: {
          email,
          name: dto.name,
          role: dto.role,
          disabled: dto.disabled,
          quotaBytes:
            dto.quotaMb === undefined
              ? undefined
              : BigInt(dto.quotaMb) * BigInt(1024 * 1024),
        },
      })
      .catch((error: unknown) => {
        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException('Email is already registered');
        }

        throw error;
      });

    await this.audit.record(auditContext, {
      action: 'user.update',
      target: 'user',
      targetId: id,
      metadata: this.cleanMetadata({
        email,
        name: dto.name,
        role: dto.role,
        disabled: dto.disabled,
        quotaMb: dto.quotaMb,
      }),
    });

    return this.serialize(updated);
  }

  async resetPassword(
    id: string,
    dto: ResetUserPasswordDto,
    auditContext: AuditContext,
  ) {
    const exists = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(dto.password, 12),
        passwordChangedAt: new Date(),
      },
    });
    await this.prisma.authSession.deleteMany({
      where: { userId: id },
    });

    await this.audit.record(auditContext, {
      action: 'user.reset_password',
      target: 'user',
      targetId: id,
    });

    return { ok: true };
  }

  async recalcUsage(id: string, auditContext: AuditContext) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const images = await this.prisma.image.findMany({
      where: {
        ownerId: id,
        uploadedAt: { not: null },
      },
      select: { sizeBytes: true },
    });
    const usedBytes = images.reduce(
      (sum, image) => sum + image.sizeBytes,
      BigInt(0),
    );

    const updated = await this.prisma.user.update({
      where: { id },
      data: { usedBytes },
    });

    await this.audit.record(auditContext, {
      action: 'user.recalculate_usage',
      target: 'user',
      targetId: id,
      metadata: { usedBytes: Number(usedBytes) },
    });

    return this.serialize(updated);
  }

  private serialize(user: {
    id: string;
    publicId: number;
    email: string;
    name: string;
    role: UserRole;
    disabled: boolean;
    quotaBytes: bigint;
    usedBytes: bigint;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...user,
      publicId: formatUserPublicId(user.publicId),
      quotaBytes: Number(user.quotaBytes),
      usedBytes: Number(user.usedBytes),
    };
  }

  private cleanMetadata(
    value: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ) as Prisma.InputJsonObject;
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
