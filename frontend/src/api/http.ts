import axios from 'axios';
import { ElMessage } from 'element-plus/es/components/message/index';
import { useAuthStore } from '@/stores/auth';

// VITE_API_BASE_URL is inlined into the bundle at build time, so changing
// it requires a rebuild: docker-compose.yml passes it as a build arg to
// frontend/Dockerfile, and the runtime `environment:` value of the same
// name is ignored by the already-built bundle. An empty string is treated
// as unset so the dev default '/api' (proxied by vite.config.ts) applies.
const rawBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
export const apiBaseUrl = rawBaseUrl ? rawBaseUrl : '/api';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Skip the global error toast for this request (background refreshes
     * and public pages that render their own empty/error state). The
     * 401 logout still runs; only the toast is suppressed.
     */
    silent?: boolean;
  }
}

export const http = axios.create({
  baseURL: apiBaseUrl,
  timeout: 20000,
});

/**
 * True when `url` points at this app's backend: a relative /api/ path
 * (the form the backend always returns for upload URLs), a URL under the
 * configured apiBaseUrl, or any same-origin absolute URL. Direct-to-S3
 * uploads are not used — S3 uploads go through the backend PUT endpoint —
 * so a non-backend URL here is unexpected and must not receive the
 * session token.
 */
export function isBackendUrl(url: string) {
  if (url.startsWith('/api/')) return true;
  const base = apiBaseUrl.replace(/\/$/, '');
  if (base && url.startsWith(base)) return true;
  if (/^https?:\/\//.test(url)) {
    try {
      return new URL(url).origin === window.location.origin;
    } catch {
      return false;
    }
  }
  return false;
}

http.interceptors.request.use((config) => {
  const auth = useAuthStore();
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    const message = await readErrorMessage(error);

    const auth = useAuthStore();
    const requestUrl = String(error.config?.url ?? '');
    const isPublicAuthRequest = [
      '/auth/login',
      '/auth/logout',
      '/auth/register',
      '/auth/password-reset/request',
      '/auth/password-reset/confirm',
    ].some((path) => requestUrl.endsWith(path));

    if (error.response?.status === 401 && auth.token && !isPublicAuthRequest) {
      auth.logout();
    }

    if (!error.config?.silent) {
      ElMessage.error(normalizeApiError(message));
    }
    return Promise.reject(error);
  },
);

/**
 * Extract the display message from an axios error. Blob bodies (a failed
 * export's JSON error arrives as a Blob because of responseType: 'blob')
 * are read and parsed as JSON first; the backend error envelope is
 * {code, message}, and validation failures arrive as a string[] message.
 */
export async function readErrorMessage(error: unknown): Promise<string> {
  const response = (error as { response?: { data?: unknown } })?.response;
  let data = response?.data;
  if (data instanceof Blob) {
    try {
      data = JSON.parse(await data.text());
    } catch {
      data = undefined;
    }
  }
  const rawMessage =
    (data as { message?: unknown } | undefined)?.message ??
    (error as { message?: unknown })?.message ??
    '请求失败，请稍后重试';
  return Array.isArray(rawMessage) ? rawMessage[0] : String(rawMessage);
}

export function normalizeApiError(message: string) {
  const translations: Array<[string, string]> = [
    ['Invalid email or password', '邮箱或密码错误'],
    ['Account is disabled', '账户已被禁用，请联系管理员'],
    ['Current password is incorrect', '当前密码错误'],
    ['Email is already registered', '该邮箱已注册'],
    ['Too many login attempts', '登录尝试次数过多，请稍后再试'],
    ['Too many password reset attempts', '密码重置请求过于频繁，请稍后再试'],
    ['Too many requests', '请求过于频繁，请稍后再试'],
    ['Missing token', '登录信息缺失，请重新登录'],
    ['Invalid token', '登录信息已失效，请重新登录'],
    ['Invalid or expired verification code', '验证码错误或已过期'],
    ['Invalid or expired reset token', '重置链接无效或已过期'],
    ['Registration is disabled', '管理员已关闭用户注册'],
    ['Registration code is required', '请输入邮箱验证码'],
    ['Verification code requested too often', '验证码发送过于频繁，请稍后再试'],
    ['Verification code is invalid or expired', '验证码错误或已过期'],
    ['Registration could not be completed', '注册未能完成，请稍后重试'],
    ['Admin permission is required', '需要管理员权限'],
  ];

  const translation = translations.find(([source]) =>
    message.toLowerCase().includes(source.toLowerCase()),
  );
  if (translation) {
    return translation[1];
  }

  if (message.includes('Third-party object storage is not configured')) {
    return '第三方对象存储未配置完整，请到控制中心填写公开域名、Endpoint、Bucket、Access Key 和 Secret Key';
  }

  if (message.includes('Network Error')) {
    return '网络请求失败，请检查服务是否可访问';
  }

  if (message.includes('Invalid character in header content')) {
    return '第三方对象存储 Access Key 或 Secret Key 包含隐藏字符，请清空后重新复制粘贴';
  }

  if (message.includes('timeout')) {
    return '请求超时，请检查网络或对象存储服务状态';
  }

  return message;
}
