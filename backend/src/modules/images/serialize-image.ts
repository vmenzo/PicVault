import type { ImageStatus, StorageProvider, Visibility } from '@prisma/client';
import type {
  StorageRuntimeConfig,
  StorageService,
} from '../storage/storage.service';

/**
 * The fields an Image row may carry into serialization. Everything not
 * listed in the returned object is internal and must never reach the API:
 * storageKey / thumbKey / webpKey / avifKey / checksum / blurhash / ownerId.
 */
export type SerializableImage = {
  id: string;
  title: string;
  description?: string | null;
  tags: string[];
  favorite: boolean;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: bigint | number;
  width?: number | null;
  height?: number | null;
  storageProvider: StorageProvider;
  storageKey: string;
  thumbKey?: string | null;
  webpKey?: string | null;
  avifKey?: string | null;
  thumbUrl?: string | null;
  webpUrl?: string | null;
  avifUrl?: string | null;
  status: ImageStatus;
  visibility: Visibility;
  views: number;
  downloads: number;
  uploadedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  albumId?: string | null;
  album?: { id: string; name: string } | null;
};

/**
 * The public ImageItem shape serializeImage() returns: only whitelisted
 * fields, with derived URLs recomputed from the runtime settings.
 */
export type SerializedImage = {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  favorite: boolean;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  storageProvider: StorageProvider;
  publicUrl: string;
  thumbUrl: string | null;
  webpUrl: string | null;
  avifUrl: string | null;
  status: ImageStatus;
  visibility: Visibility;
  views: number;
  downloads: number;
  uploadedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  albumId: string | null;
  album?: { id: string; name: string } | null;
};

/**
 * Serialize an Image row into the public ImageItem shape. Public/derived
 * URLs are always recomputed from the current runtime storage settings, so
 * a change to the public base URL or storage provider is reflected without
 * re-saving the row. Only the whitelisted fields below are returned.
 */
export function serializeImage(
  image: SerializableImage,
  setting: StorageRuntimeConfig,
  storage: StorageService,
): SerializedImage {
  const serialized: SerializedImage = {
    id: image.id,
    title: image.title,
    description: image.description ?? null,
    tags: image.tags,
    favorite: image.favorite,
    originalName: image.originalName,
    mimeType: image.mimeType,
    extension: image.extension,
    sizeBytes: Number(image.sizeBytes),
    width: image.width ?? null,
    height: image.height ?? null,
    storageProvider: image.storageProvider,
    publicUrl: storage.getPublicUrlWithBase(image.storageKey, setting),
    thumbUrl: image.thumbKey
      ? storage.getPublicUrlWithBase(image.thumbKey, setting)
      : (image.thumbUrl ?? null),
    webpUrl: image.webpKey
      ? storage.getPublicUrlWithBase(image.webpKey, setting)
      : (image.webpUrl ?? null),
    avifUrl: image.avifKey
      ? storage.getPublicUrlWithBase(image.avifKey, setting)
      : (image.avifUrl ?? null),
    status: image.status,
    visibility: image.visibility,
    views: image.views,
    downloads: image.downloads,
    uploadedAt: image.uploadedAt ?? null,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
    albumId: image.albumId ?? null,
  };

  if ('album' in image) {
    serialized.album = image.album
      ? { id: image.album.id, name: image.album.name }
      : null;
  }

  return serialized;
}
