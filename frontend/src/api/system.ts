import { http } from './http';

export type ServiceStatus = {
  // Per-service values from the backend: 'ok' | 'warning' | 'error'.
  // ('degraded' is only used for the overall SystemHealth.status below,
  // never for an individual service.)
  status: 'ok' | 'warning' | 'error';
  message?: string;
};

export type SystemHealth = {
  // Backend overallStatus(): 'ok' | 'warning' | 'degraded'.
  status: 'ok' | 'warning' | 'degraded';
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
      provider: 'LOCAL' | 'S3';
      scope: 'local-storage' | 'image-records';
      usedBytes: number;
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
