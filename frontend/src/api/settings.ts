import { http } from './http';
import type {
  AppSetting,
  StorageProvider,
  UploadPolicy,
  Visibility,
} from './types';

export function getAppSettingApi() {
  return http.get<unknown, AppSetting>('/settings/app');
}

export function getUploadPolicyApi() {
  return http.get<unknown, UploadPolicy>('/settings/app');
}

export function updateAppSettingApi(payload: {
  publicBaseUrl?: string | null;
  appPublicUrl?: string | null;
  storageProvider?: StorageProvider;
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3Bucket?: string | null;
  s3AccessKey?: string | null;
  s3SecretKey?: string | null;
  s3ForcePathStyle?: boolean;
  localStoragePath?: string | null;
  maxSizeMb?: number;
  defaultQuotaMb?: number;
  allowedTypes?: string[];
  defaultVisibility?: Visibility;
  generateThumbnail?: boolean;
  generateWebp?: boolean;
  generateAvif?: boolean;
  stripMetadata?: boolean;
  watermark?: boolean;
  watermarkText?: string;
  hotlinkProtection?: boolean;
  uploadAudit?: boolean;
  apiUpload?: boolean;
  telegramBotEnabled?: boolean;
  telegramBotToken?: string | null;
  telegramAllowedChatIds?: string[];
  telegramAlbumId?: string | null;
  smtpEnabled?: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  smtpFrom?: string | null;
}) {
  return http.patch<unknown, AppSetting>('/settings/app', payload);
}

export function testEmailApi(payload: { email: string }) {
  return http.post<unknown, { ok: boolean }>(
    '/settings/app/email-test',
    payload,
  );
}

export function testStorageApi() {
  return http.post<
    unknown,
    {
      ok: boolean;
      provider: StorageProvider;
      endpoint?: string | null;
      bucket?: string | null;
      message: string;
    }
  >('/settings/app/storage-test', {});
}
