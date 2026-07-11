<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Picture } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { imageStatsApi, listImagesApi } from '@/api/images';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { ImageItem, ImageStats } from '@/api/types';
import { formatBytes, formatDate, statusLabel } from '@/utils/format';

const router = useRouter();
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
    <section class="dashboard-summary">
      <div>
        <span>全部资产</span><strong>{{ stats.total }}</strong>
      </div>
      <div>
        <span>可正常访问</span><strong>{{ stats.ready }}</strong>
      </div>
      <div>
        <span>相册</span><strong>{{ stats.albums }}</strong>
      </div>
      <div>
        <span>回收站</span><strong>{{ stats.deleted }}</strong>
      </div>
      <el-button :icon="Picture" @click="router.push('/library')"
        >打开图片库</el-button
      >
    </section>

    <section class="dashboard-workspace">
      <el-card shadow="never" class="panel-card dashboard-recent">
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

      <aside class="dashboard-side">
        <section class="storage-strip">
          <div class="panel-head">
            <strong>容量</strong>
            <button type="button" @click="router.push('/settings')">
              管理
            </button>
          </div>
          <div class="storage-values">
            <strong>{{ formatBytes(stats.usedBytes) }}</strong>
            <span>/ {{ formatBytes(stats.quotaBytes) }}</span>
          </div>
          <el-progress
            :percentage="quotaUsage"
            :show-text="false"
            :stroke-width="8"
          />
          <small>已使用 {{ quotaUsage }}%</small>
        </section>

        <section class="dashboard-status">
          <div class="panel-head"><strong>处理状态</strong></div>
          <div>
            <span>等待或处理中</span><strong>{{ stats.pending }}</strong>
          </div>
          <div>
            <span>处理失败</span
            ><strong :class="{ danger: stats.failed > 0 }">{{
              stats.failed
            }}</strong>
          </div>
          <div>
            <span>可正常访问</span><strong>{{ stats.ready }}</strong>
          </div>
        </section>
      </aside>
    </section>
  </div>
</template>
