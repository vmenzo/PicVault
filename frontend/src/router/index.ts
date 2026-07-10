import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/reset-password',
      name: 'reset-password',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/s/:id',
      name: 'share',
      component: () => import('@/views/ShareView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        {
          path: '',
          redirect: '/dashboard',
        },
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/views/DashboardView.vue'),
          meta: {
            title: '总览',
            subtitle: '查看图片资产、存储占用和最近上传动态',
          },
        },
        {
          path: 'library',
          name: 'library',
          component: () => import('@/views/LibraryView.vue'),
          meta: {
            title: '图片库',
            subtitle: '检索、筛选、批量管理和复制图片外链',
          },
        },
        {
          path: 'upload',
          name: 'upload',
          component: () => import('@/views/UploadView.vue'),
          meta: {
            title: '上传',
            subtitle: '本地上传、远程导入和剪贴板上传入口',
          },
        },
        {
          path: 'albums',
          name: 'albums',
          component: () => import('@/views/AlbumsView.vue'),
          meta: { title: '相册', subtitle: '按项目、用途或客户整理图片资产' },
        },
        {
          path: 'trash',
          name: 'trash',
          component: () => import('@/views/TrashView.vue'),
          meta: { title: '回收站', subtitle: '恢复误删图片或执行永久删除' },
        },
        {
          path: 'links',
          name: 'links',
          component: () => import('@/views/LinksView.vue'),
          meta: {
            title: '链接工具',
            subtitle: '生成 URL、Markdown、HTML 和 BBCode 格式',
          },
        },
        {
          path: 'tools',
          name: 'tools',
          component: () => import('@/views/ToolsView.vue'),
          meta: {
            title: '图片工具箱',
            subtitle: '在浏览器内压缩、转换和导出图片',
          },
        },
        {
          path: 'control',
          name: 'control',
          component: () => import('@/views/ControlCenterView.vue'),
          meta: {
            title: '站点设置',
            subtitle: '配置存储驱动、上传策略、处理流程和 Telegram Bot',
            adminOnly: true,
          },
        },
        {
          path: 'system',
          name: 'system',
          component: () => import('@/views/SystemStatusView.vue'),
          meta: {
            title: '系统状态',
            subtitle: '查看运行状态、依赖服务、队列和图床占用',
            adminOnly: true,
          },
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('@/views/AdminView.vue'),
          meta: {
            title: '用户与维护',
            subtitle: '管理用户、审计日志、维护任务和 Bot 运行状态',
            adminOnly: true,
          },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/SettingsView.vue'),
          meta: {
            title: '账户与 API',
            subtitle: '维护个人资料、安全设置、容量和 API Key',
          },
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) {
    await auth.loadProfile();
  }

  if (!to.meta.public && !auth.token) {
    return '/login';
  }

  if (to.meta.adminOnly && auth.user?.role !== 'ADMIN') {
    return '/dashboard';
  }

  if ((to.name === 'login' || to.name === 'reset-password') && auth.token) {
    return '/dashboard';
  }
});
