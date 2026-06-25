<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Delete, RefreshLeft } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listImagesApi,
  permanentDeleteImageApi,
  restoreImageApi,
} from '@/api/images';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { ImageItem } from '@/api/types';
import { formatBytes, formatDate } from '@/utils/format';

const loading = ref(false);
const images = ref<ImageItem[]>([]);

async function load() {
  loading.value = true;
  try {
    const data = await listImagesApi({ status: 'DELETED', pageSize: 100 });
    images.value = data.items;
  } finally {
    loading.value = false;
  }
}

async function restore(image: ImageItem) {
  await restoreImageApi(image.id);
  ElMessage.success('已恢复');
  load();
}

async function remove(image: ImageItem) {
  await ElMessageBox.confirm(`永久删除 ${image.title}？`, '永久删除', {
    type: 'warning',
  });
  await permanentDeleteImageApi(image.id);
  ElMessage.success('已永久删除');
  load();
}

onMounted(load);
</script>

<template>
  <div class="page-stack">
    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="panel-head">
          <strong>回收站</strong>
          <el-button :icon="RefreshLeft" @click="load">刷新</el-button>
        </div>
      </template>
      <el-table :data="images" v-loading="loading" class="clean-table">
        <el-table-column label="图片" min-width="280">
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
        <el-table-column label="删除时间" width="180">
          <template #default="{ row }">{{
            formatDate(row.updatedAt || row.createdAt)
          }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="RefreshLeft" @click="restore(row)"
              >恢复</el-button
            >
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click="remove(row)"
            />
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
