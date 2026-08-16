import { http } from './http';
import type { User } from './types';

export type AuthResponse = {
  accessToken: string;
  user: User;
};

export function loginApi(payload: { email: string; password: string }) {
  return http.post<unknown, AuthResponse>('/auth/login', payload);
}

export function registerApi(payload: {
  email: string;
  password: string;
  verificationCode?: string;
}) {
  return http.post<unknown, AuthResponse>('/auth/register', payload);
}

export function requestRegistrationCodeApi(payload: { email: string }) {
  return http.post<unknown, { ok: boolean }>(
    '/auth/registration-code',
    payload,
  );
}

export function registrationStatusApi() {
  return http.get<
    unknown,
    {
      firstUser: boolean;
      registrationEnabled: boolean;
      emailVerificationRequired: boolean;
    }
  >('/auth/registration-status');
}

export function requestPasswordResetApi(payload: { email: string }) {
  return http.post<unknown, { ok: boolean }>(
    '/auth/password-reset/request',
    payload,
  );
}

export function resetPasswordApi(payload: {
  token: string;
  newPassword: string;
}) {
  return http.post<unknown, { ok: boolean }>(
    '/auth/password-reset/confirm',
    payload,
  );
}

export function meApi() {
  return http.get<unknown, User>('/auth/me');
}

export function updateProfileApi(payload: {
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}) {
  return http.patch<unknown, User>('/auth/profile', payload);
}

export function changePasswordApi(payload: {
  currentPassword: string;
  newPassword: string;
}) {
  return http.post<unknown, { ok: boolean }>('/auth/change-password', payload);
}
