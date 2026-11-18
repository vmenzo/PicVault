<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Picture, UploadFilled } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { imageStatsApi, listImagesApi } from '@/api/images';
import MetricCard from '@/components/MetricCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import PanelCard from '@/components/PanelCard.vue';
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

// Inline SVG donut geometry (replaces the CSS conic-gradient div).
const donutRadius = 80;
const donutCircumference = 2 * Math.PI * donutRadius;
const donutSegments = computed(() => {
  const total = stats.value.total || 0;
  let offset = 0;
  return chartSegments.value.map((segment) => {
    const fraction = total ? segment.value / total : 0;
    const length = fraction * donutCircumference;
    const item = {
      ...segment,
      dasharray: `${length} ${donutCircumference - length}`,
      dashoffset: -offset * donutCircumference,
    };
    offset += fraction;
    return item;
  });
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
    <PageHeader
      eyebrow="资产工作台"
      title="图片都在这里，随取随用。"
      subtitle="上传、整理并生成可直接分享的图片链接。"
    >
      <template #actions>
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
      </template>
    </PageHeader>

    <section class="dashboard-metrics" aria-label="资产概览">
      <MetricCard
        label="全部图片"
        :value="stats.total"
        hint="查看全部资产"
        clickable
        @click="router.push('/library')"
      />
      <MetricCard
        label="可正常访问"
        :value="stats.ready"
        hint="已完成处理"
        clickable
        @click="openStatus('READY')"
      />
      <MetricCard
        label="正在处理"
        :value="stats.pending"
        hint="等待生成链接"
        clickable
        @click="openStatus('PROCESSING')"
      />
      <MetricCard
        label="相册"
        :value="stats.albums"
        hint="整理图片集合"
        clickable
        @click="router.push('/albums')"
      />
    </section>

    <section class="dashboard-workspace">
      <PanelCard
        title="资产状态分布"
        subtitle="当前图片的处理与可用状态"
        class="dashboard-chart-card"
      >
        <template #action>
          <el-button link type="primary" @click="router.push('/library')"
            >查看图片库</el-button
          >
        </template>
        <div class="asset-chart-layout">
          <div class="asset-donut">
            <svg
              class="asset-donut-svg"
              viewBox="0 0 200 200"
              role="img"
              :aria-label="`资产状态分布，共 ${stats.total} 项资产`"
            >
              <g transform="rotate(-90 100 100)">
                <circle
                  class="donut-track"
                  cx="100"
                  cy="100"
                  :r="donutRadius"
                  stroke-width="28"
                />
                <circle
                  v-for="segment in donutSegments"
                  :key="segment.status"
                  class="donut-segment"
                  cx="100"
                  cy="100"
                  :r="donutRadius"
                  stroke-width="28"
                  :stroke="segment.color"
                  :stroke-dasharray="segment.dasharray"
                  :stroke-dashoffset="segment.dashoffset"
                />
              </g>
              <text
                x="100"
                y="98"
                text-anchor="middle"
                font-size="30"
                font-weight="700"
              >
                {{ stats.total }}
              </text>
              <text
                x="100"
                y="120"
                text-anchor="middle"
                class="donut-label"
              >
                全部资产
              </text>
            </svg>
            <table class="pv-sr-only">
              <caption>资产状态分布</caption>
              <thead>
                <tr>
                  <th scope="col">状态</th>
                  <th scope="col">数量</th>
                  <th scope="col">占比</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="segment in chartSegments" :key="segment.status">
                  <td>{{ segment.label }}</td>
                  <td>{{ segment.value }}</td>
                  <td>{{ segment.percentage }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="asset-chart-legend">
            <button
              v-for="segment in chartSegments"
              :key="segment.status"
              type="button"
              :aria-label="`${segment.label} ${segment.value} 项，占 ${segment.percentage}%`"
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
      </PanelCard>

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
