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

    if (error.response?.status === 401) {
      const auth = useAuthStore();
      auth.logout();
    }

    ElMessage.error(normalizeApiError(message));
    return Promise.reject(error);
  },
);

export function normalizeApiError(message: string) {
  if (message.includes('Third-party object storage is not configured')) {
    return '第三方对象存储未配置完整，请到控制中心填写公开域名、Endpoint、Bucket、Access Key 和 Secret Key';
  }

  if (message.includes('Network Error')) {
    return '网络请求失败，请检查服务是否可访问，或第三方对象存储 CORS 是否允许当前域名';
  }

  if (message.includes('timeout')) {
    return '请求超时，请检查网络或对象存储服务状态';
  }

  return message;
}
