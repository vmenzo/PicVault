<script setup lang="ts">
import { computed, ref } from 'vue';
import { CopyDocument } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { copyToClipboard } from '@/utils/clipboard';

const url = ref('');
const alt = ref('image');

const formats = computed(() => ({
  URL: url.value,
  Markdown: `![${alt.value}](${url.value})`,
  HTML: `<img src="${url.value}" alt="${alt.value}">`,
  BBCode: `[img]${url.value}[/img]`,
  'Markdown Link': `[${alt.value}](${url.value})`,
}));

async function copy(value: string) {
  if (!value) return;
  if (!(await copyToClipboard(value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success('已复制');
}
</script>

<template>
  <div class="content-grid links-workbench">
    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="panel-head">
          <div class="panel-title-copy">
            <strong>链接格式转换</strong>
            <span>输入一次，生成常用发布格式</span>
          </div>
        </div>
      </template>
      <el-form label-position="top">
        <el-form-item label="图片 URL">
          <el-input v-model="url" placeholder="https://example.com/image.png" />
        </el-form-item>
        <el-form-item label="Alt 文本">
          <el-input v-model="alt" />
        </el-form-item>
      </el-form>
      <div class="copy-list">
        <div v-for="(value, key) in formats" :key="key">
          <span>{{ key }}</span>
          <el-input :model-value="value" readonly>
            <template #append>
              <el-button :icon="CopyDocument" @click="copy(value)" />
            </template>
          </el-input>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="panel-head">
          <div class="panel-title-copy">
            <strong>格式指南</strong>
            <span>根据发布位置选择正确格式</span>
          </div>
        </div>
      </template>
      <div class="feature-list">
        <div>
          <strong>博客</strong>
          <span>Markdown 图片语法</span>
        </div>
        <div>
          <strong>论坛</strong>
          <span>BBCode 图片语法</span>
        </div>
        <div>
          <strong>网页</strong>
          <span>HTML img 标签</span>
        </div>
      </div>
    </el-card>
  </div>
</template>
