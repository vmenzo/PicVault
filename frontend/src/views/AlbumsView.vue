<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Delete, Edit, Plus, Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import {
  createAlbumApi,
  deleteAlbumApi,
  listAlbumsApi,
  updateAlbumApi,
} from '@/api/albums';
import { listImagesApi } from '@/api/images';
import PageHeader from '@/components/PageHeader.vue';
import PanelCard from '@/components/PanelCard.vue';
import ProtectedImage from '@/components/ProtectedImage.vue';
import type { Album, ImageItem, Visibility } from '@/api/types';
import { formatDate, visibilityLabel } from '@/utils/format';

const router = useRouter();
const loading = ref(false);
const dialogVisible = ref(false);
const editingId = ref('');
const albums = ref<Album[]>([]);
/** Latest image per album, used as the cover thumbnail. */
const covers = ref<Record<string, ImageItem>>({});
const searchQuery = ref('');
const sortBy = ref<'name' | 'createdAt' | 'imageCount'>('createdAt');
const page = ref(1);
const pageSize = ref(12);

const filteredAlbums = computed(() => {
  const needle = searchQuery.value.trim().toLowerCase();
  const list = needle
    ? albums.value.filter((album) =>
        `${album.name} ${album.description ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : [...albums.value];
  if (sortBy.value === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } else if (sortBy.value === 'imageCount') {
    list.sort((a, b) => (b.imageCount ?? 0) - (a.imageCount ?? 0));
  } else {
    list.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  return list;
});
const pagedAlbums = computed(() =>
  filteredAlbums.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);

function openAlbum(album: Album) {
  router.push({ path: '/library', query: { albumId: album.id } });
}

async function loadCovers(list: Album[]) {
  // One cheap latest-image lookup per album; failures leave the album
  // without a cover instead of breaking the list.
  const entries = await Promise.all(
    list.map(async (album) => {
      try {
        const data = await listImagesApi({ albumId: album.id, pageSize: 1 });
        return [album.id, data.items[0]] as const;
      } catch {
        return [album.id, undefined] as const;
      }
    }),
  );
  const next: Record<string, ImageItem> = {};
  for (const [albumId, image] of entries) {
    if (image) next[albumId] = image;
  }
  covers.value = next;
}
const form = reactive({
  name: '',
  description: '',
  visibility: 'PRIVATE' as Visibility,
});

async function load() {
  loading.value = true;
  try {
    albums.value = await listAlbumsApi();
    page.value = 1;
    await loadCovers(albums.value);
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
    <PageHeader
      eyebrow="相册"
      title="相册集合"
      subtitle="用相册归档主题图片，不会改变原始文件位置"
    >
      <template #actions>
        <el-button type="primary" :icon="Plus" @click="openCreate"
          >新建相册</el-button
        >
      </template>
    </PageHeader>

    <PanelCard :loading="loading">
      <div class="toolbar album-toolbar">
        <el-input
          v-model="searchQuery"
          placeholder="搜索相册名称或描述"
          clearable
          class="toolbar-search"
          @input="page = 1"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="sortBy"
          class="toolbar-select"
          placeholder="排序"
          @change="page = 1"
        >
          <el-option label="最新创建" value="createdAt" />
          <el-option label="名称" value="name" />
          <el-option label="图片数" value="imageCount" />
        </el-select>
        <span class="toolbar-count">{{ filteredAlbums.length }} 个相册</span>
      </div>
      <el-table
        :data="pagedAlbums"
        class="clean-table desktop-data-table album-table"
        @row-click="openAlbum"
      >
        <el-table-column label="封面" width="76">
          <template #default="{ row }">
            <ProtectedImage
              v-if="covers[row.id]"
              class="album-cover"
              :image="covers[row.id]"
              :alt="`${row.name} 封面`"
            />
            <div v-else class="album-cover album-cover-empty">
              {{ row.imageCount ?? 0 }} 张
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="相册" min-width="220">
          <template #default="{ row }">
            <div class="album-cell">
              <div>
                <el-button link type="primary" @click="openAlbum(row)">
                  {{ row.name }}
                </el-button>
                <span>{{ row.description || '无描述' }}</span>
              </div>
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
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="openAlbum(row)"
              >查看图片</el-button
            >
            <el-button size="small" :icon="Edit" @click.stop="openEdit(row)"
              >编辑</el-button
            >
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click.stop="remove(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-if="!loading && !filteredAlbums.length"
        :description="
          searchQuery ? '没有符合搜索条件的相册' : '还没有相册，点击右上角新建一个'
        "
      >
        <el-button
          v-if="!searchQuery"
          type="primary"
          :icon="Plus"
          @click="openCreate"
        >
          新建相册
        </el-button>
      </el-empty>
      <el-pagination
        v-if="filteredAlbums.length > pageSize"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        layout="total, prev, pager, next"
        :page-sizes="[12, 24, 48]"
        :total="filteredAlbums.length"
        class="album-pagination"
      />
      <div class="mobile-record-list album-mobile-list">
        <article
          v-for="album in pagedAlbums"
          :key="album.id"
          class="mobile-record"
          @click="openAlbum(album)"
        >
          <div class="mobile-record-head">
            <ProtectedImage
              v-if="covers[album.id]"
              class="album-cover"
              :image="covers[album.id]"
              :alt="`${album.name} 封面`"
            />
            <div>
              <strong>{{ album.name }}</strong>
              <span>{{ album.description || '暂无描述' }}</span>
            </div>
            <b>{{ album.imageCount ?? 0 }} 张</b>
          </div>
          <dl>
            <div><dt>可见性</dt><dd>{{ visibilityLabel(album.visibility) }}</dd></div>
            <div><dt>创建时间</dt><dd>{{ formatDate(album.createdAt) }}</dd></div>
          </dl>
          <div class="mobile-record-actions">
            <el-button type="primary" @click="openAlbum(album)">查看图片</el-button>
            <el-button :icon="Edit" @click.stop="openEdit(album)">编辑</el-button>
            <el-button type="danger" plain :icon="Delete" @click.stop="remove(album)">
              删除
            </el-button>
          </div>
        </article>
        <el-empty
          v-if="!loading && !filteredAlbums.length"
          :description="
            searchQuery ? '没有符合搜索条件的相册' : '还没有相册'
          "
        />
        <el-pagination
          v-if="filteredAlbums.length > pageSize"
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="prev, pager, next"
          :page-sizes="[12, 24, 48]"
          :total="filteredAlbums.length"
          class="album-pagination"
        />
      </div>
    </PanelCard>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑相册' : '新建相册'"
      width="min(460px, calc(100vw - 32px))"
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
