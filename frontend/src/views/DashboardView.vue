<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Connection,
  Folder,
  Picture,
  Setting,
  Tickets,
  UploadFilled,
  Wallet,
} from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { imageStatsApi, listImagesApi } from '@/api/images';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { ImageItem, ImageStats } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { formatBytes, formatDate, statusLabel } from '@/utils/format';

const router = useRouter();
const auth = useAuthStore();
const loading = ref(true);
const stats = ref<ImageStats>({
  total: 0,
  ready: 0,
  pending: 0,
  failed: 0,
  deleted: 0,
  albums: 0,
  usedBytes: 0,
  quotaBytes: 0,
});
const latest = ref<ImageItem[]>([]);
const quotaUsage = computed(() => {
  if (!stats.value.quotaBytes) return 0;
  return Math.min(
    Math.round((stats.value.usedBytes / stats.value.quotaBytes) * 100),
    100,
  );
});

const cards = [
  { key: 'total', label: '图片总数', icon: Picture },
  { key: 'ready', label: '可访问', icon: Tickets },
  { key: 'albums', label: '相册', icon: UploadFilled },
  { key: 'usedBytes', label: '已用容量', icon: Wallet },
] as const;
const quickActions = computed(() => [
  {
    label: '上传图片',
    description: '本地、远程或剪贴板上传',
    icon: UploadFilled,
    path: '/upload',
    type: 'primary',
  },
  {
    label: '管理图片库',
    description: '筛选、批量处理、复制外链',
    icon: Picture,
    path: '/library',
    type: 'default',
  },
  {
    label: '整理相册',
    description: '按项目归档图片资产',
    icon: Folder,
    path: '/albums',
    type: 'default',
  },
  {
    label: '生成链接',
    description: 'URL、Markdown、HTML 格式',
    icon: Connection,
    path: '/links',
    type: 'default',
  },
  ...(auth.user?.role === 'ADMIN'
    ? [
        {
          label: '系统配置',
          description: '存储、策略、Bot 与安全',
          icon: Setting,
          path: '/control',
          type: 'default',
        },
      ]
    : []),
]);

onMounted(async () => {
  loading.value = true;
  try {
    const [statsData, imagesData] = await Promise.all([
      imageStatsApi(),
      listImagesApi({ page: 1, pageSize: 8 }),
    ]);
    stats.value = statsData;
    latest.value = imagesData.items;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page-stack" v-loading="loading">
    <section class="metrics-grid">
      <el-card
        v-for="card in cards"
        :key="card.key"
        shadow="never"
        class="metric-card"
      >
        <div class="metric-icon">
          <el-icon><component :is="card.icon" /></el-icon>
        </div>
        <div>
          <span>{{ card.label }}</span>
          <strong>
            {{
              card.key === 'usedBytes'
                ? formatBytes(stats[card.key])
                : stats[card.key]
            }}
          </strong>
        </div>
      </el-card>
    </section>

    <section class="quick-action-grid">
      <button
        v-for="action in quickActions"
        :key="action.path"
        type="button"
        class="quick-action"
        :class="{ primary: action.type === 'primary' }"
        @click="router.push(action.path)"
      >
        <span>
          <el-icon><component :is="action.icon" /></el-icon>
        </span>
        <strong>{{ action.label }}</strong>
        <em>{{ action.description }}</em>
      </button>
    </section>

    <section class="content-grid">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>最近上传</strong>
            <el-button link type="primary" @click="router.push('/library')"
              >查看全部</el-button
            >
          </div>
        </template>
        <el-table :data="latest" class="clean-table">
          <el-table-column label="图片" min-width="260">
            <template #default="{ row }">
              <div class="image-row">
                <ProtectedImage :image="row" :alt="row.title" />
                <div>
                  <strong>{{ row.title }}</strong>
                  <span>{{ row.originalName }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{
              formatBytes(row.sizeBytes)
            }}</template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag size="small">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{
              formatDate(row.createdAt)
            }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>存储状态</strong>
            <el-button link type="primary" @click="router.push('/settings')"
              >容量设置</el-button
            >
          </div>
        </template>
        <div class="quota-panel">
          <el-progress type="dashboard" :percentage="quotaUsage" />
          <div>
            <strong>{{ formatBytes(stats.usedBytes) }}</strong>
            <span>总额度 {{ formatBytes(stats.quotaBytes) }}</span>
          </div>
        </div>
      </el-card>
    </section>
  </div>
</template>
