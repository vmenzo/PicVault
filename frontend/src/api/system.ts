import { http } from './http';

export type ServiceStatus = {
  status: 'ok' | 'warning' | 'error';
  message?: string;
};

export type SystemHealth = {
  status: string;
  uptimeSeconds: number;
  startedAt: string;
  nodeVersion: string;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  services: {
    database: ServiceStatus;
    redis: ServiceStatus & {
      host: string;
      port: number;
    };
    storage: ServiceStatus & {
      provider: string;
      endpoint: string;
      bucket: string;
      publicBaseUrl: string;
    };
    telegram: {
      enabledAccounts: number;
    };
    queue: ServiceStatus & {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      paused: number;
    };
    disk: ServiceStatus & {
      path: string;
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
    };
    backup: ServiceStatus & {
      directory: string;
      count: number;
      latest: null | {
        name: string;
        path: string;
        sizeBytes: number;
        fileCount: number;
        createdAt: string;
      };
    };
  };
  counts: {
    users: number;
    images: number;
    albums: number;
    apiKeys: number;
  };
};

export function systemHealthApi() {
  return http.get<unknown, SystemHealth>('/system/health');
}
