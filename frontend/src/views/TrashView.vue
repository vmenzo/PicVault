<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Delete, RefreshLeft } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import {
  emptyExpiredTrashApi,
  listImagesApi,
  permanentDeleteImageApi,
  restoreImageApi,
} from '@/api/images';
import { getAppSettingApi } from '@/api/settings';
import { useAuthStore } from '@/stores/auth';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { ImageItem } from '@/api/types';
import { formatBytes, formatDate } from '@/utils/format';

const loading = ref(false);
const images = ref<ImageItem[]>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const retentionDays = ref(30);
const auth = useAuthStore();

async function load() {
  loading.value = true;
  try {
    const data = await listImagesApi({
      status: 'DELETED',
      page: page.value,
      pageSize: pageSize.value,
    });
    images.value = data.items;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

async function restore(image: ImageItem) {
  if (!isRestorable(image)) {
    ElMessage.warning('只有已上传的图片可以恢复');
    return;
  }

  await restoreImageApi(image.id);
  ElMessage.success('已恢复并重新处理');
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

onMounted(async () => {
  if (auth.user?.role !== 'ADMIN') return;
  const setting = await getAppSettingApi();
  retentionDays.value = setting.trashRetentionDays;
});

async function emptyExpired() {
  await ElMessageBox.confirm(
    `永久删除进入回收站超过 ${retentionDays.value} 天的图片？`,
    '清理回收站',
    { type: 'warning' },
  );
  const result = await emptyExpiredTrashApi();
  ElMessage.success(`已永久删除 ${result.affected} 张图片`);
  page.value = 1;
  await load();
}

function changePage(value: number) {
  page.value = value;
  void load();
}

function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
  void load();
}

function isRestorable(image: ImageItem) {
  return image.status === 'DELETED' && Boolean(image.uploadedAt);
}
</script>

<template>
  <div class="page-stack">
    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="panel-head">
          <strong>回收站</strong>
          <el-button :icon="RefreshLeft" @click="load">刷新</el-button>
          <el-button type="danger" plain :icon="Delete" @click="emptyExpired">
            清理过期图片
          </el-button>
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
            <el-button
              size="small"
              :icon="RefreshLeft"
              :disabled="!isRestorable(row)"
              @click="restore(row)"
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
      <div class="table-pagination">
        <el-pagination
          background
          layout="total, sizes, prev, pager, next"
          :total="total"
          :current-page="page"
          :page-size="pageSize"
          :page-sizes="[20, 50, 100]"
          @update:current-page="changePage"
          @update:page-size="changePageSize"
        />
      </div>
    </el-card>
  </div>
</template>
