<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { CopyDocument, Download, Picture } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { publicImageInfoApi } from '@/api/images';
import type { ImageItem } from '@/api/types';
import { copyToClipboard } from '@/utils/clipboard';
import { formatBytes, formatDate, visibilityLabel } from '@/utils/format';
import { toAbsoluteUrl } from '@/utils/url';

const route = useRoute();
const loading = ref(true);
const image = ref<ImageItem | null>(null);

const downloadUrl = computed(() =>
  image.value
    ? `${window.location.origin}/api/public/images/${image.value.id}/download`
    : '',
);

const formats = computed(() => {
  if (!image.value) return [];
  const publicUrl = toAbsoluteUrl(image.value.publicUrl);
  return [
    { label: 'URL', value: publicUrl },
    {
      label: 'Markdown',
      value: `![${image.value.title}](${publicUrl})`,
    },
    {
      label: 'HTML',
      value: `<img src="${publicUrl}" alt="${image.value.title}">`,
    },
    { label: 'BBCode', value: `[img]${publicUrl}[/img]` },
    { label: '下载', value: downloadUrl.value },
    { label: 'WebP', value: toAbsoluteUrl(image.value.webpUrl) },
    { label: 'AVIF', value: toAbsoluteUrl(image.value.avifUrl) },
  ].filter((item): item is { label: string; value: string } =>
    Boolean(item.value),
  );
});

async function copy(value: string, label: string) {
  if (!(await copyToClipboard(value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success(`${label}已复制`);
}

onMounted(async () => {
  loading.value = true;
  try {
    image.value = await publicImageInfoApi(String(route.params.id));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <main class="share-page" v-loading="loading">
    <section v-if="image" class="share-shell">
      <div class="share-preview">
        <img :src="image.publicUrl" :alt="image.title" />
      </div>

      <aside class="share-panel">
        <div class="brand compact-brand">
          <div class="brand-mark">
            <el-icon><Picture /></el-icon>
          </div>
          <div>
            <strong>PicVault</strong>
            <span>公开分享</span>
          </div>
        </div>

        <h1>{{ image.title }}</h1>
        <p>{{ image.description || image.originalName }}</p>

        <div class="variant-grid">
          <div>
            <strong>{{ formatBytes(image.sizeBytes) }}</strong>
            <span>大小</span>
          </div>
          <div>
            <strong
              >{{ image.width || '-' }} × {{ image.height || '-' }}</strong
            >
            <span>尺寸</span>
          </div>
          <div>
            <strong>{{ image.views }}</strong>
            <span>浏览</span>
          </div>
        </div>

        <div v-if="image.tags?.length" class="tag-row">
          <el-tag v-for="tag in image.tags" :key="tag" effect="plain">
            {{ tag }}
          </el-tag>
        </div>

        <el-descriptions :column="1" border>
          <el-descriptions-item label="文件名">
            {{ image.originalName }}
          </el-descriptions-item>
          <el-descriptions-item label="类型">{{
            image.mimeType
          }}</el-descriptions-item>
          <el-descriptions-item label="可见性">
            {{ visibilityLabel(image.visibility) }}
          </el-descriptions-item>
          <el-descriptions-item label="上传时间">
            {{ formatDate(image.createdAt) }}
          </el-descriptions-item>
        </el-descriptions>

        <div class="share-actions">
          <el-button
            type="primary"
            :icon="Download"
            tag="a"
            :href="downloadUrl"
          >
            下载原图
          </el-button>
          <el-button
            :icon="CopyDocument"
            @click="copy(toAbsoluteUrl(image.publicUrl), 'URL')"
          >
            复制外链
          </el-button>
        </div>

        <div class="copy-list">
          <div v-for="item in formats" :key="item.label">
            <span>{{ item.label }}</span>
            <el-input :model-value="item.value" readonly>
              <template #append>
                <el-button
                  :icon="CopyDocument"
                  @click="copy(item.value, item.label)"
                />
              </template>
            </el-input>
          </div>
        </div>
      </aside>
    </section>

    <el-empty v-else-if="!loading" description="图片不存在或未公开" />
  </main>
</template>
