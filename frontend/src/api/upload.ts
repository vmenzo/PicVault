import axios from 'axios';
import {
  http,
  isBackendUrl,
  normalizeApiError,
  readErrorMessage,
} from './http';
import { useAuthStore } from '@/stores/auth';
import type { ImageItem, StorageProvider, Visibility } from './types';

export type SignUploadResponse = {
  imageId: string;
  key: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  publicUrl: string;
  // Advisory only: the backend PUT URL carries no expiry and the value
  // is not enforced server-side (see UploadService.create).
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
  // The backend always returns its own PUT endpoint (/api/upload/<key>/
  // object) for LOCAL and S3 alike, so uploads never go direct to S3
  // and no S3 CORS setup is involved. The session token is attached
  // only for backend URLs (see isBackendUrl in http.ts). A raw axios
  // instance is used instead of `http` because the returned URL already
  // contains the '/api' prefix, which http's baseURL would duplicate.
  return axios
    .put(url, file, {
      headers: {
        ...headers,
        ...(isBackendUrl(url) && auth.token
          ? { Authorization: `Bearer ${auth.token}` }
          : {}),
      },
      onUploadProgress: (event) => {
        if (!event.total || !onUploadProgress) return;
        onUploadProgress(Math.round((event.loaded / event.total) * 100));
      },
    })
    .then((response) => response.data as ImageItem | { ok: boolean })
    .catch(async (error) => {
      // Same handling as the http interceptor: 401 logs out, and the
      // message goes through normalizeApiError (including blob bodies).
      if (error.response?.status === 401 && auth.token) {
        auth.logout();
      }
      throw new Error(normalizeApiError(await readErrorMessage(error)));
    });
}
