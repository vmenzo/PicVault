<script setup lang="ts">
import {
  Connection,
  Delete,
  DataBoard,
  Folder,
  Grid,
  House,
  Key,
  Link,
  Menu,
  Picture,
  Search,
  SetUp,
  Setting,
  Tools,
  UploadFilled,
} from '@element-plus/icons-vue';
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const mobileNavVisible = ref(false);
const globalQuery = ref('');

const navItems = [
  { path: '/dashboard', label: '总览', icon: House, group: '资产' },
  { path: '/library', label: '图片库', icon: Picture, group: '资产' },
  { path: '/upload', label: '上传', icon: UploadFilled, group: '资产' },
  { path: '/albums', label: '相册', icon: Folder, group: '资产' },
  { path: '/trash', label: '回收站', icon: Delete, group: '资产' },
  { path: '/links', label: '链接工具', icon: Connection, group: '工具' },
  { path: '/tools', label: '图片工具箱', icon: Tools, group: '工具' },
  {
    path: '/control',
    label: '控制中心',
    icon: SetUp,
    group: '系统',
    adminOnly: true,
  },
  {
    path: '/system',
    label: '系统状态',
    icon: DataBoard,
    group: '系统',
    adminOnly: true,
  },
  {
    path: '/admin',
    label: '管理中心',
    icon: Key,
    group: '系统',
    adminOnly: true,
  },
  { path: '/settings', label: '账户与 API', icon: Setting, group: '系统' },
];

const visibleNavItems = computed(() =>
  navItems.filter((item) => !item.adminOnly || auth.user?.role === 'ADMIN'),
);

const navGroups = ['资产', '工具', '系统'];
const pageTitle = computed(() => String(route.meta.title ?? 'PicVault'));
const pageSubtitle = computed(() =>
  String(route.meta.subtitle ?? '图片资产管理平台'),
);

function go(path: string) {
  mobileNavVisible.value = false;
  router.push(path);
}

function submitGlobalSearch() {
  const q = globalQuery.value.trim();
  if (!q) {
    ElMessage.warning('请输入搜索关键词');
    return;
  }

  router.push({
    path: '/library',
    query: { q },
  });
}

watch(
  () => route.fullPath,
  () => {
    globalQuery.value =
      route.path === '/library' && typeof route.query.q === 'string'
        ? route.query.q
        : '';
  },
  { immediate: true },
);

function handleUserCommand(command: string) {
  if (command === 'settings') {
    router.push('/settings');
  }

  if (command === 'logout') {
    auth.logout();
  }
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="232px" class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">
          <el-icon><Grid /></el-icon>
        </div>
        <div>
          <strong>PicVault</strong>
          <span>图片资产平台</span>
        </div>
      </div>

      <el-menu
        :default-active="route.path"
        class="sidebar-menu"
        background-color="transparent"
        text-color="#64748b"
        active-text-color="#2563eb"
        @select="go"
      >
        <template v-for="group in navGroups" :key="group">
          <div class="nav-group-title">{{ group }}</div>
          <el-menu-item
            v-for="item in visibleNavItems.filter((nav) => nav.group === group)"
            :key="item.path"
            :index="item.path"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </el-menu-item>
        </template>
      </el-menu>

      <div class="sidebar-footer">
        <span>Workspace</span>
        <strong>{{
          auth.user?.role === 'ADMIN' ? 'Administrator' : 'Member'
        }}</strong>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <div class="header-title">
          <el-button
            class="mobile-menu-button"
            :icon="Menu"
            @click="mobileNavVisible = true"
          />
          <div>
            <h1>{{ pageTitle }}</h1>
            <p>{{ pageSubtitle }}</p>
          </div>
        </div>
        <div class="header-actions">
          <el-input
            v-model="globalQuery"
            class="global-search"
            placeholder="搜索图片、标签、文件名"
            clearable
            @keyup.enter="submitGlobalSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-button :icon="Link" @click="router.push('/links')">
            链接
          </el-button>
          <el-button
            type="primary"
            :icon="UploadFilled"
            @click="router.push('/upload')"
          >
            上传
          </el-button>
          <el-dropdown trigger="click" @command="handleUserCommand">
            <button class="user-button">
              <span>{{ auth.user?.name?.slice(0, 1).toUpperCase() }}</span>
              <strong>{{ auth.user?.name || 'Account' }}</strong>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="settings">账户设置</el-dropdown-item>
                <el-dropdown-item command="logout" divided
                  >退出登录</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="app-main">
        <RouterView />
      </el-main>
    </el-container>

    <el-drawer
      v-model="mobileNavVisible"
      title="导航"
      direction="ltr"
      size="280px"
    >
      <div class="mobile-nav">
        <button
          v-for="item in visibleNavItems"
          :key="item.path"
          type="button"
          :class="{ active: route.path === item.path }"
          @click="go(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </div>
    </el-drawer>
  </el-container>
</template>
