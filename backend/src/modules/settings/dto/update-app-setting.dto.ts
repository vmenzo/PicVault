import { ApiPropertyOptional } from '@nestjs/swagger';
import { StorageProvider, Visibility } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
} from 'class-validator';

export class UpdateAppSettingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  publicBaseUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  appPublicUrl?: string | null;

  @ApiPropertyOptional({ enum: StorageProvider })
  @IsOptional()
  @IsEnum(StorageProvider)
  storageProvider?: StorageProvider;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  s3Endpoint?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Region?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Bucket?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3AccessKey?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3SecretKey?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  s3ForcePathStyle?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  localStoragePath?: string | null;

  @ApiPropertyOptional({ description: 'Max upload size in MiB' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxSizeMb?: number;

  @ApiPropertyOptional({ description: 'Default user quota in MiB' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1024 * 1024)
  defaultQuotaMb?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTypes?: string[];

  @ApiPropertyOptional({ enum: Visibility })
  @IsOptional()
  @IsEnum(Visibility)
  defaultVisibility?: Visibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  generateThumbnail?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  generateWebp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  generateAvif?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  stripMetadata?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  watermark?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  watermarkText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hotlinkProtection?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  uploadAudit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  apiUpload?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  telegramBotEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telegramBotToken?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  telegramAllowedChatIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telegramAlbumId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  smtpEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smtpHost?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  smtpSecure?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smtpUsername?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smtpPassword?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smtpFrom?: string | null;
}
