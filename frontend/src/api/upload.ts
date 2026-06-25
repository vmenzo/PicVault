import axios from 'axios';
import { http } from './http';
import { useAuthStore } from '@/stores/auth';
import type { ImageItem, StorageProvider, Visibility } from './types';

export type SignUploadResponse = {
  imageId: string;
  key: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  publicUrl: string;
  expiresIn: number;
};

export function signUploadApi(payload: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  albumId?: string;
  visibility?: Visibility;
  storageProvider?: StorageProvider;
}) {
  return http.post<unknown, SignUploadResponse>('/upload/sign', payload);
}

export function completeUploadApi(id: string) {
  return http.post<unknown, ImageItem>(`/upload/${id}/complete`, {});
}

export function importUrlApi(payload: {
  url: string;
  filename?: string;
  albumId?: string;
  visibility?: Visibility;
  storageProvider?: StorageProvider;
}) {
  return http.post<unknown, ImageItem>('/upload/import-url', payload);
}

export function putObject(
  url: string,
  file: File,
  headers: Record<string, string>,
  onUploadProgress?: (percent: number) => void,
) {
  const auth = useAuthStore();
  return axios
    .put(url, file, {
      headers: {
        ...headers,
        ...(url.startsWith('/api/') && auth.token
          ? { Authorization: `Bearer ${auth.token}` }
          : {}),
      },
      onUploadProgress: (event) => {
        if (!event.total || !onUploadProgress) return;
        onUploadProgress(Math.round((event.loaded / event.total) * 100));
      },
    })
    .catch((error) => {
      if (!url.startsWith('/api/') && !error.response) {
        throw new Error(
          '第三方对象存储上传失败，请检查 Bucket CORS 是否允许当前域名 PUT 上传',
        );
      }

      if (
        !url.startsWith('/api/') &&
        [403, 404].includes(error.response?.status)
      ) {
        throw new Error(
          '第三方对象存储拒绝上传，请检查 Endpoint、Bucket、权限和签名配置',
        );
      }

      throw error;
    });
}
