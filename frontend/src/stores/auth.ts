import { defineStore } from 'pinia';
import { router } from '@/router';
import { loginApi, meApi, registerApi, updateProfileApi } from '@/api/auth';
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
      verificationCode: string;
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
      } catch {
        this.clearSession();
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
    logout() {
      this.clearSession();
      router.push('/login');
    },
  },
});
