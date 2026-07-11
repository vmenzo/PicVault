<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowRight, Picture, UploadFilled } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { imageStatsApi, listImagesApi } from '@/api/images';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { ImageItem, ImageStats, ImageStatus } from '@/api/types';
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
const remainingBytes = computed(() =>
  Math.max(stats.value.quotaBytes - stats.value.usedBytes, 0),
);

const chartSegments = computed(() => {
  const total = stats.value.total || 0;
  const segments: {
    label: string;
    value: number;
    color: string;
    status: ImageStatus;
  }[] = [
    { label: '可正常访问', value: stats.value.ready, color: '#2f9e68', status: 'READY' },
    { label: '处理中', value: stats.value.pending, color: '#e6a23c', status: 'PROCESSING' },
    { label: '处理失败', value: stats.value.failed, color: '#d94b42', status: 'FAILED' },
    { label: '回收站', value: stats.value.deleted, color: '#89918d', status: 'DELETED' },
  ];

  return segments.map((segment) => ({
    ...segment,
    percentage: total ? Math.round((segment.value / total) * 100) : 0,
  }));
});

const chartStyle = computed(() => {
  if (!stats.value.total) return { background: '#e8ece9' };
  let offset = 0;
  const stops = chartSegments.value.map((segment) => {
    const start = offset;
    offset += segment.value / stats.value.total;
    return `${segment.color} ${start * 360}deg ${offset * 360}deg`;
  });
  return { background: `conic-gradient(${stops.join(', ')})` };
});

function openStatus(status: ImageStatus) {
  router.push({ path: '/library', query: { status } });
}

onMounted(async () => {
  loading.value = true;
  try {
    const [statsData, imagesData] = await Promise.all([
      imageStatsApi(),
      listImagesApi({ page: 1, pageSize: 3, sortBy: 'createdAt', sortOrder: 'desc' }),
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
    <section class="dashboard-command">
      <div>
        <span class="dashboard-command-label">资产工作台</span>
        <h2>图片都在这里，随取随用。</h2>
        <p>上传、整理并生成可直接分享的图片链接。</p>
      </div>
      <div class="dashboard-command-actions">
        <el-button :icon="Picture" @click="router.push('/library')">
          浏览图片库
        </el-button>
        <el-button
          type="primary"
          :icon="UploadFilled"
          @click="router.push('/upload')"
        >
          上传图片
        </el-button>
      </div>
    </section>

    <section class="dashboard-metrics" aria-label="资产概览">
      <button type="button" @click="router.push('/library')">
        <span>全部图片</span><strong>{{ stats.total }}</strong>
        <small>查看全部资产 <el-icon><ArrowRight /></el-icon></small>
      </button>
      <button type="button" @click="openStatus('READY')">
        <span>可正常访问</span><strong>{{ stats.ready }}</strong>
        <small>已完成处理</small>
      </button>
      <button type="button" @click="openStatus('PROCESSING')">
        <span>正在处理</span><strong>{{ stats.pending }}</strong>
        <small>等待生成链接</small>
      </button>
      <button type="button" @click="router.push('/albums')">
        <span>相册</span><strong>{{ stats.albums }}</strong>
        <small>整理图片集合</small>
      </button>
    </section>

    <section class="dashboard-workspace">
      <el-card shadow="never" class="panel-card dashboard-chart-card">
        <template #header>
          <div class="panel-head">
            <div>
              <strong>资产状态分布</strong>
              <span>当前图片的处理与可用状态</span>
            </div>
            <el-button link type="primary" @click="router.push('/library')">查看图片库</el-button>
          </div>
        </template>
        <div class="asset-chart-layout">
          <div
            class="asset-donut"
            :style="chartStyle"
            role="img"
            :aria-label="`共 ${stats.total} 项资产`"
          >
            <div class="asset-donut-center">
              <strong>{{ stats.total }}</strong>
              <span>全部资产</span>
            </div>
          </div>
          <div class="asset-chart-legend">
            <button
              v-for="segment in chartSegments"
              :key="segment.status"
              type="button"
              @click="openStatus(segment.status)"
            >
              <i :style="{ background: segment.color }"></i>
              <span>{{ segment.label }}</span>
              <strong>{{ segment.value }}</strong>
              <small>{{ segment.percentage }}%</small>
            </button>
          </div>
        </div>
        <div class="dashboard-latest">
          <div class="dashboard-latest-head">
            <strong>最近上传</strong>
            <button type="button" @click="router.push('/library')">查看全部</button>
          </div>
          <div v-if="latest.length" class="dashboard-latest-list">
            <button
              v-for="image in latest"
              :key="image.id"
              type="button"
              @click="router.push(`/library?image=${image.id}`)"
            >
              <ProtectedImage :image="image" :alt="image.title" />
              <span>
                <strong>{{ image.title }}</strong>
                <small>{{ formatDate(image.createdAt) }}</small>
              </span>
              <em>{{ statusLabel(image.status) }}</em>
            </button>
          </div>
          <el-empty v-else description="暂无上传记录" :image-size="54" />
        </div>
      </el-card>

      <aside class="dashboard-side">
        <section class="storage-strip">
          <div class="panel-head">
            <strong>容量</strong>
            <button type="button" @click="router.push('/settings')">
              管理
            </button>
          </div>
          <div class="storage-chart">
            <el-progress
              type="circle"
              :percentage="quotaUsage"
              :width="126"
              :stroke-width="10"
              color="#2457d6"
            />
          </div>
          <div class="storage-chart-values">
            <div><span>已使用</span><strong>{{ formatBytes(stats.usedBytes) }}</strong></div>
            <div><span>剩余</span><strong>{{ formatBytes(remainingBytes) }}</strong></div>
          </div>
          <small>总容量 {{ formatBytes(stats.quotaBytes) }}</small>
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
