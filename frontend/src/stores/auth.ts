import { defineStore } from 'pinia';
import { router } from '@/router';
import {
  loginApi,
  logoutApi,
  meApi,
  registerApi,
  updateProfileApi,
} from '@/api/auth';
import type { User } from '@/api/types';

const TOKEN_KEY = 'picvault-token';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) ?? '',
    user: null as User | null,
    ready: false,
  }),
  actions: {
    async login(payload: { email: string; password: string }) {
      const session = await loginApi(payload);
      this.setSession(session.accessToken, session.user);
    },
    async register(payload: {
      email: string;
      password: string;
      verificationCode?: string;
    }) {
      const session = await registerApi(payload);
      this.setSession(session.accessToken, session.user);
    },
    async updateProfile(payload: {
      name?: string;
      email?: string;
      avatarUrl?: string | null;
    }) {
      this.user = await updateProfileApi(payload);
    },
    async loadProfile() {
      if (!this.token) {
        this.ready = true;
        return;
      }

      try {
        this.user = await meApi();
      } catch (error) {
        // Only a 401 means the session is dead. A 500 or network error
        // must not wipe a valid local session (and log the user out).
        const status = (error as { response?: { status?: number } })?.response
          ?.status;
        if (status === 401) {
          this.clearSession();
        }
      } finally {
        this.ready = true;
      }
    },
    setSession(token: string, user: User) {
      this.token = token;
      this.user = user;
      localStorage.setItem(TOKEN_KEY, token);
    },
    clearSession() {
      this.token = '';
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
    },
    async logout() {
      // Revoke the server-side session first (while the token is still
      // stored, so the request carries it); clear locally regardless of
      // whether the server call succeeds.
      try {
        await logoutApi();
      } catch {
        // Already logged out server-side, or unreachable — local logout
        // still proceeds below.
      } finally {
        this.clearSession();
        router.push('/login');
      }
    },
  },
});
