<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Delete, Edit, Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import {
  createAlbumApi,
  deleteAlbumApi,
  listAlbumsApi,
  updateAlbumApi,
} from '@/api/albums';
import type { Album, Visibility } from '@/api/types';
import { formatDate, visibilityLabel } from '@/utils/format';

const loading = ref(false);
const dialogVisible = ref(false);
const editingId = ref('');
const albums = ref<Album[]>([]);
const form = reactive({
  name: '',
  description: '',
  visibility: 'PRIVATE' as Visibility,
});

async function load() {
  loading.value = true;
  try {
    albums.value = await listAlbumsApi();
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = '';
  form.name = '';
  form.description = '';
  form.visibility = 'PRIVATE';
  dialogVisible.value = true;
}

function openEdit(album: Album) {
  editingId.value = album.id;
  form.name = album.name;
  form.description = album.description ?? '';
  form.visibility = album.visibility;
  dialogVisible.value = true;
}

async function submit() {
  if (editingId.value) {
    await updateAlbumApi(editingId.value, form);
    ElMessage.success('相册已更新');
  } else {
    await createAlbumApi(form);
    ElMessage.success('相册已创建');
  }
  dialogVisible.value = false;
  load();
}

async function remove(album: Album) {
  await ElMessageBox.confirm(
    `确定删除相册 ${album.name}？图片不会被删除。`,
    '删除相册',
    {
      type: 'warning',
    },
  );
  await deleteAlbumApi(album.id);
  ElMessage.success('相册已删除');
  load();
}

onMounted(load);
</script>

<template>
  <div class="page-stack">
    <div class="page-actions">
      <el-button type="primary" :icon="Plus" @click="openCreate"
        >新建相册</el-button
      >
    </div>

    <el-card shadow="never" class="panel-card" v-loading="loading">
      <el-table :data="albums" class="clean-table">
        <el-table-column prop="name" label="相册" min-width="220">
          <template #default="{ row }">
            <div class="album-cell">
              <strong>{{ row.name }}</strong>
              <span>{{ row.description || '无描述' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="图片数" width="120">
          <template #default="{ row }">{{ row.imageCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="可见性" width="140">
          <template #default="{ row }">{{
            visibilityLabel(row.visibility)
          }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{
            formatDate(row.createdAt)
          }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)"
              >编辑</el-button
            >
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click="remove(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑相册' : '新建相册'"
      width="460"
    >
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如：博客配图" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="可见性">
          <el-segmented
            v-model="form.visibility"
            :options="[
              { label: '私有', value: 'PRIVATE' },
              { label: '公开', value: 'PUBLIC' },
              { label: '隐藏链接', value: 'UNLISTED' },
            ]"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
