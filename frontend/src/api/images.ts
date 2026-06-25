import { http } from './http';
import type { ImageItem, ImageStats, ImageStatus, Visibility } from './types';

export type ListImagesParams = {
  page?: number;
  pageSize?: number;
  albumId?: string;
  q?: string;
  status?: ImageStatus;
  visibility?: Visibility;
  tag?: string;
  favorite?: boolean;
  sortBy?:
    | 'createdAt'
    | 'updatedAt'
    | 'sizeBytes'
    | 'views'
    | 'downloads'
    | 'title';
  sortOrder?: 'asc' | 'desc';
};

export function listImagesApi(params: ListImagesParams) {
  return http.get<
    unknown,
    { items: ImageItem[]; total: number; page: number; pageSize: number }
  >('/images', { params });
}

export function imageStatsApi() {
  return http.get<unknown, ImageStats>('/images/stats');
}

export function updateImageApi(
  id: string,
  payload: Partial<
    Pick<
      ImageItem,
      'title' | 'description' | 'albumId' | 'visibility' | 'tags' | 'favorite'
    >
  >,
) {
  return http.patch<unknown, ImageItem>(`/images/${id}`, payload);
}

export function deleteImageApi(id: string) {
  return http.delete<unknown, { ok: boolean }>(`/images/${id}`);
}

export function restoreImageApi(id: string) {
  return http.post<unknown, ImageItem>(`/images/${id}/restore`, {});
}

export function permanentDeleteImageApi(id: string) {
  return http.delete<unknown, { ok: boolean }>(`/images/${id}/permanent`);
}

export function bulkImagesApi(payload: {
  ids: string[];
  action:
    | 'DELETE'
    | 'RESTORE'
    | 'PERMANENT_DELETE'
    | 'SET_VISIBILITY'
    | 'MOVE_ALBUM'
    | 'SET_FAVORITE'
    | 'ADD_TAGS'
    | 'REMOVE_TAGS'
    | 'REPROCESS';
  visibility?: Visibility;
  albumId?: string | null;
  favorite?: boolean;
  tags?: string[];
}) {
  return http.post<unknown, { affected: number }>('/images/bulk', payload);
}

export function listTagsApi() {
  return http.get<unknown, { name: string; count: number }[]>('/images/tags');
}

export function reprocessImageApi(id: string) {
  return http.post<unknown, { ok: boolean }>(`/images/${id}/reprocess`, {});
}

export function imageAssetApi(
  id: string,
  variant: 'thumb' | 'original' | 'webp' | 'avif' = 'thumb',
) {
  return http.get<unknown, Blob>(`/images/${id}/asset`, {
    params: { variant },
    responseType: 'blob',
  });
}

export function publicImageInfoApi(id: string) {
  return http.get<unknown, ImageItem>(`/public/images/${id}`);
}
