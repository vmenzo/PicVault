import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StorageProvider, UserRole, Visibility } from '@prisma/client';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAppSettingDto } from './dto/update-app-setting.dto';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../mail/mail.service';

const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];
const SECRET_MASK = '********';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => StorageService))
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  async get(ownerId: string) {
    const setting = await this.prisma.appSetting.upsert({
      where: { ownerId },
      create: { ownerId },
      update: {},
    });

    return this.serialize(setting);
  }

  async getUploadPolicy(ownerId: string) {
    const setting = await this.getRuntime(ownerId);
    return {
      storageProvider: setting.storageProvider,
      maxSizeMb: Math.round(setting.maxSizeBytes / 1024 / 1024),
      allowedTypes: setting.allowedTypes,
      defaultVisibility: setting.defaultVisibility,
      apiUpload: setting.apiUpload,
    };
  }

  async update(ownerId: string, dto: UpdateAppSettingDto) {
    const data = this.toData(dto);
    const setting = await this.prisma.appSetting.upsert({
      where: { ownerId },
      create: {
        ...(data as Prisma.AppSettingUncheckedCreateInput),
        ownerId,
      },
      update: data,
    });

    return this.serialize(setting);
  }

  async getRuntime(ownerId: string) {
    const setting = await this.findRuntimeSetting(ownerId);
    const storageProvider = setting?.storageProvider ?? StorageProvider.LOCAL;
    const s3AccessKey =
      setting?.s3AccessKey ?? this.config.get<string>('S3_ACCESS_KEY');
    const s3SecretKey =
      setting?.s3SecretKey ?? this.config.get<string>('S3_SECRET_KEY');

    return {
      publicBaseUrl: setting?.publicBaseUrl ?? null,
      storageProvider,
      s3Endpoint:
        setting?.s3Endpoint ?? this.config.get<string>('S3_ENDPOINT') ?? null,
      s3Region:
        setting?.s3Region ??
        this.config.get<string>('S3_REGION') ??
        'us-east-1',
      s3Bucket:
        setting?.s3Bucket ?? this.config.get<string>('S3_BUCKET') ?? null,
      s3AccessKey: s3AccessKey ?? null,
      s3SecretKey: s3SecretKey ?? null,
      s3ForcePathStyle:
        setting?.s3ForcePathStyle ??
        (this.config.get<string>('S3_FORCE_PATH_STYLE') ?? 'true') === 'true',
      localStoragePath:
        setting?.localStoragePath ??
        this.config.get<string>('LOCAL_STORAGE_PATH') ??
        path.resolve(process.cwd(), 'storage'),
      maxSizeBytes: setting?.maxSizeBytes ?? 50 * 1024 * 1024,
      defaultQuotaBytes:
        setting?.defaultQuotaBytes ?? BigInt(1024 * 1024 * 1024),
      allowedTypes: setting?.allowedTypes.length
        ? setting.allowedTypes
        : DEFAULT_ALLOWED_TYPES,
      defaultVisibility: setting?.defaultVisibility ?? Visibility.PRIVATE,
      generateThumbnail: setting?.generateThumbnail ?? true,
      generateWebp: setting?.generateWebp ?? true,
      generateAvif: setting?.generateAvif ?? false,
      stripMetadata: setting?.stripMetadata ?? true,
      watermark: setting?.watermark ?? false,
      watermarkText: setting?.watermarkText ?? 'PicVault',
      hotlinkProtection: setting?.hotlinkProtection ?? false,
      uploadAudit: setting?.uploadAudit ?? false,
      apiUpload: setting?.apiUpload ?? true,
      telegramBotEnabled: setting?.telegramBotEnabled ?? false,
      telegramBotToken: setting?.telegramBotToken ?? null,
      telegramAllowedChatIds: setting?.telegramAllowedChatIds ?? [],
      telegramAlbumId: setting?.telegramAlbumId ?? null,
      telegramLastUpdateId: setting?.telegramLastUpdateId ?? null,
      smtpEnabled: setting?.smtpEnabled ?? false,
      smtpHost: setting?.smtpHost ?? null,
      smtpPort: setting?.smtpPort ?? null,
      smtpSecure: setting?.smtpSecure ?? true,
      smtpUsername: setting?.smtpUsername ?? null,
      smtpPassword: setting?.smtpPassword ?? null,
      smtpFrom: setting?.smtpFrom ?? null,
    };
  }

  async testStorage(ownerId: string) {
    const setting = await this.getRuntime(ownerId);
    if (setting.storageProvider === StorageProvider.LOCAL) {
      return {
        ok: true,
        provider: setting.storageProvider,
        message: 'Local storage is configured',
      };
    }

    await this.storage.testS3Connection(setting);
    return {
      ok: true,
      provider: setting.storageProvider,
      endpoint: setting.s3Endpoint,
      bucket: setting.s3Bucket,
      message: 'Third-party object storage is reachable',
    };
  }

  async testEmail(email: string) {
    return this.mail.sendTest(email);
  }

  private toData(): Prisma.AppSettingUncheckedUpdateInput;
  private toData(
    dto: UpdateAppSettingDto,
  ): Prisma.AppSettingUncheckedUpdateInput;
  private toData(dto?: UpdateAppSettingDto) {
    const data: Prisma.AppSettingUncheckedUpdateInput = {};

    if (!dto) return data;
    if (dto.publicBaseUrl !== undefined)
      data.publicBaseUrl = this.clean(dto.publicBaseUrl);
    if (dto.storageProvider !== undefined)
      data.storageProvider = dto.storageProvider;
    if (dto.s3Endpoint !== undefined)
      data.s3Endpoint = this.clean(dto.s3Endpoint);
    if (dto.s3Region !== undefined) data.s3Region = this.clean(dto.s3Region);
    if (dto.s3Bucket !== undefined) data.s3Bucket = this.clean(dto.s3Bucket);
    if (dto.s3AccessKey !== undefined && dto.s3AccessKey !== SECRET_MASK) {
      data.s3AccessKey = this.clean(dto.s3AccessKey);
    }
    if (dto.s3SecretKey !== undefined && dto.s3SecretKey !== SECRET_MASK) {
      data.s3SecretKey = this.clean(dto.s3SecretKey);
    }
    if (dto.s3ForcePathStyle !== undefined) {
      data.s3ForcePathStyle = dto.s3ForcePathStyle;
    }
    if (dto.localStoragePath !== undefined) {
      data.localStoragePath = this.clean(dto.localStoragePath);
    }
    if (dto.maxSizeMb !== undefined) {
      data.maxSizeBytes = dto.maxSizeMb * 1024 * 1024;
    }
    if (dto.defaultQuotaMb !== undefined) {
      data.defaultQuotaBytes = BigInt(dto.defaultQuotaMb) * BigInt(1024 * 1024);
    }
    if (dto.allowedTypes !== undefined) data.allowedTypes = dto.allowedTypes;
    if (dto.defaultVisibility !== undefined) {
      data.defaultVisibility = dto.defaultVisibility;
    }
    if (dto.generateThumbnail !== undefined) {
      data.generateThumbnail = dto.generateThumbnail;
    }
    if (dto.generateWebp !== undefined) data.generateWebp = dto.generateWebp;
    if (dto.generateAvif !== undefined) data.generateAvif = dto.generateAvif;
    if (dto.stripMetadata !== undefined) data.stripMetadata = dto.stripMetadata;
    if (dto.watermark !== undefined) data.watermark = dto.watermark;
    if (dto.watermarkText !== undefined) data.watermarkText = dto.watermarkText;
    if (dto.hotlinkProtection !== undefined) {
      data.hotlinkProtection = dto.hotlinkProtection;
    }
    if (dto.uploadAudit !== undefined) data.uploadAudit = dto.uploadAudit;
    if (dto.apiUpload !== undefined) data.apiUpload = dto.apiUpload;
    if (dto.telegramBotEnabled !== undefined) {
      data.telegramBotEnabled = dto.telegramBotEnabled;
    }
    if (
      dto.telegramBotToken !== undefined &&
      dto.telegramBotToken !== SECRET_MASK
    ) {
      data.telegramBotToken = this.clean(dto.telegramBotToken);
    }
    if (dto.telegramAllowedChatIds !== undefined) {
      data.telegramAllowedChatIds = dto.telegramAllowedChatIds;
    }
    if (dto.telegramAlbumId !== undefined) {
      data.telegramAlbumId = this.clean(dto.telegramAlbumId);
    }
    if (dto.smtpEnabled !== undefined) data.smtpEnabled = dto.smtpEnabled;
    if (dto.smtpHost !== undefined) data.smtpHost = this.clean(dto.smtpHost);
    if (dto.smtpPort !== undefined) data.smtpPort = dto.smtpPort;
    if (dto.smtpSecure !== undefined) data.smtpSecure = dto.smtpSecure;
    if (dto.smtpUsername !== undefined && dto.smtpUsername !== SECRET_MASK) {
      data.smtpUsername = this.clean(dto.smtpUsername);
    }
    if (dto.smtpPassword !== undefined && dto.smtpPassword !== SECRET_MASK) {
      data.smtpPassword = this.clean(dto.smtpPassword);
    }
    if (dto.smtpFrom !== undefined) data.smtpFrom = this.clean(dto.smtpFrom);

    return data;
  }

  private serialize(setting: {
    id: string;
    publicBaseUrl: string | null;
    storageProvider: StorageProvider;
    s3Endpoint: string | null;
    s3Region: string | null;
    s3Bucket: string | null;
    s3AccessKey: string | null;
    s3SecretKey: string | null;
    s3ForcePathStyle: boolean;
    localStoragePath: string | null;
    maxSizeBytes: number;
    defaultQuotaBytes: bigint;
    allowedTypes: string[];
    defaultVisibility: Visibility;
    generateThumbnail: boolean;
    generateWebp: boolean;
    generateAvif: boolean;
    stripMetadata: boolean;
    watermark: boolean;
    watermarkText: string;
    hotlinkProtection: boolean;
    uploadAudit: boolean;
    apiUpload: boolean;
    telegramBotEnabled: boolean;
    telegramBotToken: string | null;
    telegramAllowedChatIds: string[];
    telegramAlbumId: string | null;
    telegramLastUpdateId: number | null;
    smtpEnabled: boolean;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: boolean;
    smtpUsername: string | null;
    smtpPassword: string | null;
    smtpFrom: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...setting,
      s3AccessKey: setting.s3AccessKey ? SECRET_MASK : '',
      s3SecretKey: setting.s3SecretKey ? SECRET_MASK : '',
      telegramBotToken: setting.telegramBotToken ? SECRET_MASK : '',
      smtpPassword: setting.smtpPassword ? SECRET_MASK : '',
      maxSizeMb: Math.round(setting.maxSizeBytes / 1024 / 1024),
      defaultQuotaBytes: Number(setting.defaultQuotaBytes),
      defaultQuotaMb: Math.round(
        Number(setting.defaultQuotaBytes) / 1024 / 1024,
      ),
    };
  }

  private clean(value: string | null | undefined) {
    return value?.trim() || null;
  }

  private async findRuntimeSetting(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { role: true },
    });

    if (owner?.role === UserRole.ADMIN) {
      const ownSetting = await this.prisma.appSetting.findUnique({
        where: { ownerId },
      });
      if (ownSetting) {
        return ownSetting;
      }
    }

    return this.prisma.appSetting.findFirst({
      where: {
        owner: {
          role: UserRole.ADMIN,
          disabled: false,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
