import { apiBaseUrl } from '@/api/http';

/**
 * Single place that builds absolute URLs from the same base the API
 * client uses (apiBaseUrl from http.ts). Previously each view built
 * `window.location.origin + '/api/…'` by hand, which drifted from the
 * configured base URL. The public URL format is unchanged:
 * `<origin>/api/<path>` for the default '/api' base.
 *
 * @param path API path such as '/public/images/<id>/download'.
 * @param originOverride Optional origin to use instead of the current
 *   one (ControlCenter's configured app public URL). The '/api' prefix
 *   is still applied, matching the previous behaviour there.
 */
export function apiUrl(path: string, originOverride?: string | null) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const override = originOverride?.trim();
  if (override) {
    return `${override.replace(/\/$/, '')}/api${suffix}`;
  }
  const base = apiBaseUrl.replace(/\/$/, '');
  if (/^https?:\/\//.test(base)) {
    return `${base}${suffix}`;
  }
  return `${window.location.origin}${base}${suffix}`;
}

/** Absolute URL for a same-origin site path such as '/s/<id>'. */
export function siteUrl(path: string) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${window.location.origin}${suffix}`;
}
