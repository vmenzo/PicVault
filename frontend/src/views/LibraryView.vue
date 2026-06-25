<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  CopyDocument,
  Delete,
  Download,
  Edit,
  Grid,
  Link,
  List,
  Refresh,
  Search,
  Star,
  UploadFilled,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { listAlbumsApi } from '@/api/albums';
import ProtectedImage from '@/components/ProtectedImage.vue';
import {
  bulkImagesApi,
  deleteImageApi,
  listImagesApi,
  listTagsApi,
  permanentDeleteImageApi,
  reprocessImageApi,
  restoreImageApi,
  updateImageApi,
} from '@/api/images';
import type { Album, ImageItem, ImageStatus, Visibility } from '@/api/types';
import { copyToClipboard } from '@/utils/clipboard';
import {
  formatBytes,
  formatDate,
  statusLabel,
  visibilityLabel,
} from '@/utils/format';
import { toAbsoluteUrl } from '@/utils/url';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const images = ref<ImageItem[]>([]);
const albums = ref<Album[]>([]);
const tags = ref<{ name: string; count: number }[]>([]);
const total = ref(0);
const selectedIds = ref<string[]>([]);
const detailVisible = ref(false);
const bulkLinksVisible = ref(false);
const selectedImage = ref<ImageItem | null>(null);
const viewMode = ref<'grid' | 'table'>('grid');
const linkFormat = ref<
  'url' | 'markdown' | 'html' | 'bbcode' | 'share' | 'download'
>('url');
const editForm = reactive({
  title: '',
  description: '',
  albumId: '',
  visibility: 'PRIVATE' as Visibility,
  tags: [] as string[],
  favorite: false,
});
const query = reactive({
  page: 1,
  pageSize: 24,
  q: '',
  albumId: '',
  status: '' as '' | ImageStatus,
  visibility: '' as '' | Visibility,
  tag: '',
  favorite: false,
  sortBy: 'createdAt' as
    | 'createdAt'
    | 'updatedAt'
    | 'sizeBytes'
    | 'views'
    | 'downloads'
    | 'title',
  sortOrder: 'desc' as 'asc' | 'desc',
});

const albumOptions = computed(() => [
  { id: '', name: '全部相册' },
  ...albums.value,
]);
const moveAlbumOptions = computed(() => [
  { id: '', name: '不加入相册' },
  ...albums.value,
]);
const selectedImages = computed(() =>
  images.value.filter((image) => selectedIds.value.includes(image.id)),
);
const allVisibleSelected = computed(
  () =>
    images.value.length > 0 &&
    images.value.every((image) => selectedIds.value.includes(image.id)),
);
const selectedBulkLinks = computed(() =>
  selectedImages.value
    .map((image) => formatImageLink(image, linkFormat.value))
    .filter(Boolean)
    .join('\n'),
);

async function load() {
  loading.value = true;
  try {
    const data = await listImagesApi({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q || undefined,
      albumId: query.albumId || undefined,
      status: query.status || undefined,
      visibility: query.visibility || undefined,
      tag: query.tag || undefined,
      favorite: query.favorite || undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
    images.value = data.items;
    total.value = data.total;
    selectedIds.value = selectedIds.value.filter((id) =>
      data.items.some((image) => image.id === id),
    );
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  query.q = '';
  query.albumId = '';
  query.status = '';
  query.visibility = '';
  query.tag = '';
  query.favorite = false;
  query.sortBy = 'createdAt';
  query.sortOrder = 'desc';
  query.page = 1;
  load();
}

function toggleSelect(id: string, checked: boolean) {
  if (checked) {
    selectedIds.value = [...new Set([...selectedIds.value, id])];
  } else {
    selectedIds.value = selectedIds.value.filter((item) => item !== id);
  }
}

function toggleSelectAll(checked: boolean) {
  selectedIds.value = checked ? images.value.map((image) => image.id) : [];
}

function handleCardCheck(id: string) {
  return (checked: string | number | boolean) => {
    toggleSelect(id, Boolean(checked));
  };
}

function openDetail(image: ImageItem) {
  selectedImage.value = image;
  editForm.title = image.title;
  editForm.description = image.description ?? '';
  editForm.albumId = image.album?.id ?? image.albumId ?? '';
  editForm.visibility = image.visibility;
  editForm.tags = [...(image.tags ?? [])];
  editForm.favorite = image.favorite;
  detailVisible.value = true;
}

function linkFormats(image: ImageItem) {
  if (!isShareable(image)) {
    return [];
  }

  const publicUrl = shareablePublicUrl(image);
  const rows = [
    { label: 'URL', value: publicUrl },
    { label: 'Markdown', value: `![${image.title}](${publicUrl})` },
    { label: 'HTML', value: `<img src="${publicUrl}" alt="${image.title}">` },
    { label: 'BBCode', value: `[img]${publicUrl}[/img]` },
    { label: '分享页', value: shareUrl(image) },
    { label: '下载', value: downloadUrl(image) },
    { label: '缩略图', value: toAbsoluteUrl(image.thumbUrl) },
    { label: 'WebP', value: toAbsoluteUrl(image.webpUrl) },
    { label: 'AVIF', value: toAbsoluteUrl(image.avifUrl) },
  ];

  return rows.filter((row): row is { label: string; value: string } =>
    Boolean(row.value),
  );
}

function formatImageLink(
  image: ImageItem,
  format: 'url' | 'markdown' | 'html' | 'bbcode' | 'share' | 'download',
) {
  if (!isShareable(image)) return '';

  const publicUrl = shareablePublicUrl(image);
  if (format === 'markdown') return `![${image.title}](${publicUrl})`;
  if (format === 'html') return `<img src="${publicUrl}" alt="${image.title}">`;
  if (format === 'bbcode') return `[img]${publicUrl}[/img]`;
  if (format === 'share') return shareUrl(image);
  if (format === 'download') return downloadUrl(image);
  return publicUrl;
}

function isShareable(image: ImageItem) {
  return image.status === 'READY' && image.visibility !== 'PRIVATE';
}

function shareablePublicUrl(image: ImageItem) {
  return isShareable(image) ? toAbsoluteUrl(image.publicUrl) : '';
}

async function copyText(value: string, label = '内容') {
  if (!value) return;
  if (!(await copyToClipboard(value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success(`${label}已复制`);
}

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function saveImage() {
  if (!selectedImage.value) return;
  const updated = await updateImageApi(selectedImage.value.id, {
    title: editForm.title,
    description: editForm.description,
    albumId: editForm.albumId || null,
    visibility: editForm.visibility,
    tags: editForm.tags,
    favorite: editForm.favorite,
  });
  selectedImage.value = updated;
  ElMessage.success('图片信息已保存');
  tags.value = await listTagsApi();
  load();
}

async function remove(row: ImageItem) {
  await ElMessageBox.confirm(`确定移入回收站：${row.title}？`, '删除图片', {
    type: 'warning',
  });
  await deleteImageApi(row.id);
  ElMessage.success('已移入回收站');
  detailVisible.value = false;
  load();
}

async function restore(row: ImageItem) {
  await restoreImageApi(row.id);
  ElMessage.success('已恢复');
  detailVisible.value = false;
  load();
}

async function permanentRemove(row: ImageItem) {
  await ElMessageBox.confirm(
    `永久删除 ${row.title}？此操作不可恢复。`,
    '永久删除',
    {
      type: 'warning',
    },
  );
  await permanentDeleteImageApi(row.id);
  ElMessage.success('已永久删除');
  detailVisible.value = false;
  load();
}

async function bulkDelete() {
  if (!selectedIds.value.length) return;
  await ElMessageBox.confirm(
    `确定将 ${selectedIds.value.length} 张图片移入回收站？`,
    '批量删除',
    {
      type: 'warning',
    },
  );
  await bulkImagesApi({ ids: selectedIds.value, action: 'DELETE' });
  selectedIds.value = [];
  ElMessage.success('已批量删除');
  load();
}

async function bulkRestore() {
  if (!selectedIds.value.length) return;
  await bulkImagesApi({ ids: selectedIds.value, action: 'RESTORE' });
  selectedIds.value = [];
  ElMessage.success('已批量恢复');
  load();
}

async function bulkSetVisibility(visibility: Visibility) {
  if (!selectedIds.value.length) return;
  await bulkImagesApi({
    ids: selectedIds.value,
    action: 'SET_VISIBILITY',
    visibility,
  });
  ElMessage.success('可见性已更新');
  load();
}

async function bulkMove(albumId: string) {
  if (!selectedIds.value.length) return;
  await bulkImagesApi({
    ids: selectedIds.value,
    action: 'MOVE_ALBUM',
    albumId: albumId || null,
  });
  ElMessage.success('相册已更新');
  load();
}

async function bulkSetFavorite(favorite: boolean) {
  if (!selectedIds.value.length) return;
  await bulkImagesApi({
    ids: selectedIds.value,
    action: 'SET_FAVORITE',
    favorite,
  });
  ElMessage.success(favorite ? '已加入收藏' : '已取消收藏');
  load();
}

async function bulkTags(action: 'ADD_TAGS' | 'REMOVE_TAGS') {
  if (!selectedIds.value.length) return;
  const { value } = await ElMessageBox.prompt(
    '多个标签用逗号、空格或中文逗号分隔',
    action === 'ADD_TAGS' ? '批量打标签' : '批量移除标签',
    {
      inputPlaceholder: '例如: blog banner avatar',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    },
  );
  const nextTags = String(value ?? '')
    .split(/[\s,，]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!nextTags.length) return;

  await bulkImagesApi({
    ids: selectedIds.value,
    action,
    tags: nextTags,
  });
  tags.value = await listTagsApi();
  ElMessage.success(action === 'ADD_TAGS' ? '标签已添加' : '标签已移除');
  load();
}

async function bulkReprocess() {
  if (!selectedIds.value.length) return;
  await bulkImagesApi({
    ids: selectedIds.value,
    action: 'REPROCESS',
  });
  ElMessage.success('已提交重新处理任务');
  load();
}

async function reprocess(row: ImageItem) {
  await reprocessImageApi(row.id);
  ElMessage.success('已提交重新处理任务');
  detailVisible.value = false;
  load();
}

function shareUrl(image: ImageItem) {
  return isShareable(image) ? `${window.location.origin}/s/${image.id}` : '';
}

function downloadUrl(image: ImageItem) {
  return isShareable(image)
    ? `${window.location.origin}/api/public/images/${image.id}/download`
    : '';
}

onMounted(async () => {
  if (typeof route.query.q === 'string') {
    query.q = route.query.q;
  }
  const [albumData, tagData] = await Promise.all([
    listAlbumsApi(),
    listTagsApi(),
  ]);
  albums.value = albumData;
  tags.value = tagData;
  load();
});

watch(
  () => route.query.q,
  (value) => {
    const nextQuery = typeof value === 'string' ? value : '';
    if (nextQuery === query.q) return;

    query.q = nextQuery;
    query.page = 1;
    load();
  },
);
</script>

<template>
  <div class="page-stack">
    <el-card shadow="never" class="panel-card">
      <div class="toolbar library-toolbar">
        <el-input
          v-model="query.q"
          placeholder="搜索标题或文件名"
          clearable
          class="toolbar-search"
          @keyup.enter="load"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="query.albumId"
          class="toolbar-select"
          @change="load"
        >
          <el-option
            v-for="album in albumOptions"
            :key="album.id"
            :label="album.name"
            :value="album.id"
          />
        </el-select>
        <el-select
          v-model="query.status"
          class="toolbar-select"
          placeholder="状态"
          @change="load"
        >
          <el-option label="全部状态" value="" />
          <el-option label="可访问" value="READY" />
          <el-option label="处理中" value="PROCESSING" />
          <el-option label="失败" value="FAILED" />
          <el-option label="回收站" value="DELETED" />
        </el-select>
        <el-select
          v-model="query.visibility"
          class="toolbar-select"
          placeholder="可见性"
          @change="load"
        >
          <el-option label="全部可见性" value="" />
          <el-option label="私有" value="PRIVATE" />
          <el-option label="公开" value="PUBLIC" />
          <el-option label="隐藏链接" value="UNLISTED" />
        </el-select>
        <el-select
          v-model="query.tag"
          class="toolbar-select"
          placeholder="标签"
          clearable
          @change="load"
        >
          <el-option
            v-for="tag in tags"
            :key="tag.name"
            :label="`${tag.name} (${tag.count})`"
            :value="tag.name"
          />
        </el-select>
        <el-checkbox v-model="query.favorite" @change="load">收藏</el-checkbox>
        <el-select
          v-model="query.sortBy"
          class="toolbar-select"
          placeholder="排序字段"
          @change="load"
        >
          <el-option label="上传时间" value="createdAt" />
          <el-option label="更新时间" value="updatedAt" />
          <el-option label="文件大小" value="sizeBytes" />
          <el-option label="浏览量" value="views" />
          <el-option label="下载量" value="downloads" />
          <el-option label="标题" value="title" />
        </el-select>
        <el-segmented
          v-model="query.sortOrder"
          :options="[
            { label: '降序', value: 'desc' },
            { label: '升序', value: 'asc' },
          ]"
          @change="load"
        />
        <el-segmented
          v-model="viewMode"
          :options="[
            { label: '网格', value: 'grid' },
            { label: '表格', value: 'table' },
          ]"
        >
          <template #default="{ item }">
            <el-icon v-if="item.value === 'grid'"><Grid /></el-icon>
            <el-icon v-else><List /></el-icon>
            <span>{{ item.label }}</span>
          </template>
        </el-segmented>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button @click="resetFilters">重置</el-button>
        <el-button
          type="primary"
          :icon="UploadFilled"
          @click="router.push('/upload')"
        >
          上传图片
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel-card" v-if="selectedIds.length">
      <div class="bulk-bar">
        <strong>已选择 {{ selectedIds.length }} 张</strong>
        <div class="bulk-actions">
          <el-button
            size="small"
            @click="
              copyText(
                selectedImages
                  .map(shareablePublicUrl)
                  .filter(Boolean)
                  .join('\n'),
                '外链',
              )
            "
          >
            复制外链
          </el-button>
          <el-button
            size="small"
            :icon="CopyDocument"
            @click="bulkLinksVisible = true"
          >
            链接面板
          </el-button>
          <el-button
            size="small"
            @click="
              copyText(
                selectedImages
                  .map((item) => shareUrl(item))
                  .filter(Boolean)
                  .join('\n'),
                '分享页',
              )
            "
          >
            复制分享页
          </el-button>
          <el-dropdown @command="bulkSetVisibility">
            <el-button size="small">改可见性</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="PRIVATE">私有</el-dropdown-item>
                <el-dropdown-item command="PUBLIC">公开</el-dropdown-item>
                <el-dropdown-item command="UNLISTED">隐藏链接</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-dropdown @command="bulkMove">
            <el-button size="small">移动相册</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="album in moveAlbumOptions"
                  :key="album.id"
                  :command="album.id"
                >
                  {{ album.name }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" @click="bulkSetFavorite(true)"
            >收藏</el-button
          >
          <el-button size="small" @click="bulkSetFavorite(false)"
            >取消收藏</el-button
          >
          <el-button size="small" @click="bulkTags('ADD_TAGS')"
            >打标签</el-button
          >
          <el-button size="small" @click="bulkTags('REMOVE_TAGS')"
            >删标签</el-button
          >
          <el-button size="small" @click="bulkReprocess">重新处理</el-button>
          <el-button size="small" @click="bulkRestore">恢复</el-button>
          <el-button size="small" type="danger" plain @click="bulkDelete"
            >删除</el-button
          >
        </div>
      </div>
    </el-card>

    <div class="library-select-all">
      <el-checkbox :model-value="allVisibleSelected" @change="toggleSelectAll">
        选择当前页
      </el-checkbox>
      <span>{{ total }} 张图片</span>
    </div>

    <div v-if="viewMode === 'grid'" class="image-grid" v-loading="loading">
      <el-empty v-if="!loading && !images.length" description="暂无图片">
        <el-button
          type="primary"
          :icon="UploadFilled"
          @click="router.push('/upload')"
        >
          去上传
        </el-button>
      </el-empty>

      <el-card
        v-for="image in images"
        :key="image.id"
        shadow="never"
        class="image-card"
        :class="{ selected: selectedIds.includes(image.id) }"
      >
        <div class="image-thumb" @click="openDetail(image)">
          <ProtectedImage :image="image" :alt="image.title" />
          <el-icon v-if="image.favorite" class="favorite-badge"
            ><Star
          /></el-icon>
          <el-checkbox
            class="image-check"
            :model-value="selectedIds.includes(image.id)"
            @click.stop
            @change="handleCardCheck(image.id)"
          />
          <el-tag
            size="small"
            :type="image.status === 'READY' ? 'success' : 'warning'"
          >
            {{ statusLabel(image.status) }}
          </el-tag>
        </div>
        <div class="image-meta" @click="openDetail(image)">
          <strong>{{ image.title }}</strong>
          <span>{{ image.originalName }}</span>
        </div>
        <div class="image-facts">
          <span>{{ formatBytes(image.sizeBytes) }}</span>
          <span>{{ visibilityLabel(image.visibility) }}</span>
          <span>{{ image.album?.name || '未分组' }}</span>
        </div>
        <div v-if="image.tags?.length" class="tag-row">
          <el-tag
            v-for="tag in image.tags.slice(0, 3)"
            :key="tag"
            size="small"
            effect="plain"
          >
            {{ tag }}
          </el-tag>
        </div>
        <div class="image-actions">
          <el-button
            size="small"
            :icon="Link"
            @click="copyText(toAbsoluteUrl(image.publicUrl), '外链')"
            :disabled="!isShareable(image)"
          >
            外链
          </el-button>
          <el-button
            size="small"
            :disabled="!isShareable(image)"
            @click="copyText(shareUrl(image), '分享页')"
            >分享</el-button
          >
          <el-button
            size="small"
            :icon="Download"
            :disabled="!isShareable(image)"
            @click="openUrl(downloadUrl(image))"
          />
          <el-button size="small" :icon="Edit" @click="openDetail(image)"
            >详情</el-button
          >
          <el-button
            v-if="image.status !== 'DELETED'"
            size="small"
            type="danger"
            plain
            :icon="Delete"
            @click="remove(image)"
          >
            删除
          </el-button>
          <el-button v-else size="small" @click="restore(image)"
            >恢复</el-button
          >
        </div>
      </el-card>
    </div>

    <el-card v-else shadow="never" class="panel-card" v-loading="loading">
      <el-table :data="images" class="clean-table" @row-dblclick="openDetail">
        <el-table-column width="48">
          <template #default="{ row }">
            <el-checkbox
              :model-value="selectedIds.includes(row.id)"
              @change="handleCardCheck(row.id)"
            />
          </template>
        </el-table-column>
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
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.status === 'READY' ? 'success' : 'warning'"
            >
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可见性" width="110">
          <template #default="{ row }">{{
            visibilityLabel(row.visibility)
          }}</template>
        </el-table-column>
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{
            formatBytes(row.sizeBytes)
          }}</template>
        </el-table-column>
        <el-table-column label="浏览/下载" width="120">
          <template #default="{ row }"
            >{{ row.views }} / {{ row.downloads }}</template
          >
        </el-table-column>
        <el-table-column label="相册" width="140">
          <template #default="{ row }">{{
            row.album?.name || '未分组'
          }}</template>
        </el-table-column>
        <el-table-column label="上传时间" width="170">
          <template #default="{ row }">{{
            formatDate(row.createdAt)
          }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :icon="Link"
              :disabled="!isShareable(row)"
              @click="copyText(shareablePublicUrl(row), '外链')"
            />
            <el-button
              size="small"
              :disabled="!isShareable(row)"
              @click="copyText(shareUrl(row), '分享页')"
              >分享</el-button
            >
            <el-button
              size="small"
              :icon="Download"
              :disabled="!isShareable(row)"
              @click="openUrl(downloadUrl(row))"
            />
            <el-button size="small" :icon="Edit" @click="openDetail(row)"
              >详情</el-button
            >
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !images.length" description="暂无图片" />
    </el-card>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      layout="total, sizes, prev, pager, next"
      :page-sizes="[12, 24, 48, 96]"
      :total="total"
      @change="load"
    />

    <el-drawer v-model="detailVisible" title="图片详情" size="520px">
      <div v-if="selectedImage" class="image-detail">
        <ProtectedImage
          class="detail-preview"
          :image="selectedImage"
          :alt="selectedImage.title"
        />

        <el-form label-position="top">
          <el-form-item label="标题">
            <el-input v-model="editForm.title" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input
              v-model="editForm.description"
              type="textarea"
              :rows="3"
            />
          </el-form-item>
          <el-form-item label="相册">
            <el-select v-model="editForm.albumId" class="full-width">
              <el-option
                v-for="album in moveAlbumOptions"
                :key="album.id"
                :label="album.name"
                :value="album.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="可见性">
            <el-segmented
              v-model="editForm.visibility"
              :options="[
                { label: '私有', value: 'PRIVATE' },
                { label: '公开', value: 'PUBLIC' },
                { label: '隐藏链接', value: 'UNLISTED' },
              ]"
            />
          </el-form-item>
          <el-form-item label="标签">
            <el-select
              v-model="editForm.tags"
              multiple
              filterable
              allow-create
              default-first-option
              class="full-width"
              placeholder="输入后回车创建标签"
            >
              <el-option
                v-for="tag in tags"
                :key="tag.name"
                :label="tag.name"
                :value="tag.name"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="收藏">
            <el-switch v-model="editForm.favorite" />
          </el-form-item>
        </el-form>

        <div class="variant-grid">
          <div>
            <strong>{{ selectedImage.views }}</strong>
            <span>浏览</span>
          </div>
          <div>
            <strong>{{ selectedImage.downloads }}</strong>
            <span>下载</span>
          </div>
          <div>
            <strong
              >{{ selectedImage.width || '-' }} ×
              {{ selectedImage.height || '-' }}</strong
            >
            <span>尺寸</span>
          </div>
        </div>

        <div class="copy-list">
          <div v-for="item in linkFormats(selectedImage)" :key="item.label">
            <span>{{ item.label }}</span>
            <el-input :model-value="item.value" readonly>
              <template #append>
                <el-button
                  :icon="CopyDocument"
                  @click="copyText(item.value, item.label)"
                />
              </template>
            </el-input>
          </div>
        </div>

        <el-descriptions :column="1" border>
          <el-descriptions-item label="文件名">{{
            selectedImage.originalName
          }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{
            selectedImage.mimeType
          }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{
            formatBytes(selectedImage.sizeBytes)
          }}</el-descriptions-item>
          <el-descriptions-item label="浏览">{{
            selectedImage.views
          }}</el-descriptions-item>
          <el-descriptions-item label="下载">{{
            selectedImage.downloads
          }}</el-descriptions-item>
          <el-descriptions-item label="宽高">
            {{ selectedImage.width || '-' }} × {{ selectedImage.height || '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="创建时间">{{
            formatDate(selectedImage.createdAt)
          }}</el-descriptions-item>
        </el-descriptions>

        <div class="drawer-actions">
          <el-button type="primary" @click="saveImage">保存</el-button>
          <el-button
            v-if="selectedImage.status !== 'DELETED'"
            type="danger"
            plain
            @click="remove(selectedImage)"
          >
            移入回收站
          </el-button>
          <el-button
            v-if="selectedImage.status !== 'DELETED'"
            @click="reprocess(selectedImage)"
          >
            重新处理
          </el-button>
          <el-button v-else @click="restore(selectedImage)">恢复</el-button>
          <el-button
            v-if="selectedImage.status === 'DELETED'"
            type="danger"
            @click="permanentRemove(selectedImage)"
          >
            永久删除
          </el-button>
        </div>
      </div>
    </el-drawer>

    <el-drawer v-model="bulkLinksVisible" title="批量链接" size="520px">
      <div class="page-stack">
        <el-alert
          title="选择格式后可以一次复制当前已选图片链接"
          type="info"
          :closable="false"
        />
        <el-segmented
          v-model="linkFormat"
          :options="[
            { label: 'URL', value: 'url' },
            { label: 'Markdown', value: 'markdown' },
            { label: 'HTML', value: 'html' },
            { label: 'BBCode', value: 'bbcode' },
            { label: '分享页', value: 'share' },
            { label: '下载', value: 'download' },
          ]"
        />
        <el-input
          :model-value="selectedBulkLinks"
          type="textarea"
          :rows="12"
          readonly
        />
        <div class="drawer-actions">
          <el-button
            type="primary"
            :icon="CopyDocument"
            @click="copyText(selectedBulkLinks, '批量链接')"
          >
            复制
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>
