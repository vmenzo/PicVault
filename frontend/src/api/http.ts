import axios from 'axios';
import { ElMessage } from 'element-plus/es/components/message/index';
import { useAuthStore } from '@/stores/auth';

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 20000,
});

http.interceptors.request.use((config) => {
  const auth = useAuthStore();
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const rawMessage =
      error.response?.data?.message ?? error.message ?? '请求失败，请稍后重试';
    const message = Array.isArray(rawMessage) ? rawMessage[0] : rawMessage;

    const auth = useAuthStore();
    const requestUrl = String(error.config?.url ?? '');
    const isPublicAuthRequest = [
      '/auth/login',
      '/auth/register',
      '/auth/password-reset/request',
      '/auth/password-reset/confirm',
    ].some((path) => requestUrl.endsWith(path));

    if (error.response?.status === 401 && auth.token && !isPublicAuthRequest) {
      auth.logout();
    }

    ElMessage.error(normalizeApiError(message));
    return Promise.reject(error);
  },
);

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
    return '网络请求失败，请检查服务是否可访问，或第三方对象存储 CORS 是否允许当前域名';
  }

  if (message.includes('Invalid character in header content')) {
    return '第三方对象存储 Access Key 或 Secret Key 包含隐藏字符，请清空后重新复制粘贴';
  }

  if (message.includes('timeout')) {
    return '请求超时，请检查网络或对象存储服务状态';
  }

  return message;
}
