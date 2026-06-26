export type Visibility = 'PRIVATE' | 'PUBLIC' | 'UNLISTED';
export type ImageStatus =
  | 'PENDING'
  | 'READY'
  | 'PROCESSING'
  | 'FAILED'
  | 'DELETED';
export type StorageProvider = 'S3' | 'LOCAL';

export type User = {
  id: string;
  publicId: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  quotaBytes: number;
  usedBytes: number;
};

export type Album = {
  id: string;
  name: string;
  description?: string;
  visibility: Visibility;
  imageCount?: number;
  createdAt: string;
};

export type ImageItem = {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  favorite: boolean;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  albumId?: string | null;
  width?: number;
  height?: number;
  publicUrl: string;
  thumbUrl?: string;
  webpUrl?: string;
  avifUrl?: string;
  status: ImageStatus;
  visibility: Visibility;
  views: number;
  downloads: number;
  createdAt: string;
  updatedAt: string;
  album?: Pick<Album, 'id' | 'name'>;
};

export type ImageStats = {
  total: number;
  ready: number;
  pending: number;
  failed: number;
  deleted: number;
  albums: number;
  usedBytes: number;
  quotaBytes: number;
};

export type ApiKey = {
  id: string;
  name: string;
  key?: string;
  lastUsedAt?: string | null;
  createdAt: string;
};

export type AppSetting = {
  id: string;
  publicBaseUrl?: string | null;
  appPublicUrl?: string | null;
  storageProvider: StorageProvider;
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3Bucket?: string | null;
  s3AccessKey?: string | null;
  s3SecretKey?: string | null;
  s3ForcePathStyle: boolean;
  localStoragePath?: string | null;
  maxSizeMb: number;
  defaultQuotaBytes: number;
  defaultQuotaMb: number;
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
  telegramBotToken?: string | null;
  telegramAllowedChatIds: string[];
  telegramAlbumId?: string | null;
  telegramLastUpdateId?: number | null;
  smtpEnabled: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure: boolean;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  smtpFrom?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UploadPolicy = Pick<
  AppSetting,
  | 'storageProvider'
  | 'maxSizeMb'
  | 'allowedTypes'
  | 'defaultVisibility'
  | 'apiUpload'
>;
