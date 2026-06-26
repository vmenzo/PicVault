<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { UploadRawFile, UploadRequestOptions } from 'element-plus';
import { ElMessage } from 'element-plus/es/components/message/index';
import {
  Check,
  CircleClose,
  CopyDocument,
  Files,
  Link,
  Refresh,
  UploadFilled,
} from '@element-plus/icons-vue';
import { listAlbumsApi } from '@/api/albums';
import { getUploadPolicyApi } from '@/api/settings';
import {
  completeUploadApi,
  importUrlApi,
  putObject,
  signUploadApi,
} from '@/api/upload';
import type {
  Album,
  StorageProvider,
  UploadPolicy,
  Visibility,
} from '@/api/types';
import { copyToClipboard } from '@/utils/clipboard';
import { formatBytes } from '@/utils/format';
import { toAbsoluteUrl } from '@/utils/url';

type QueueStatus =
  | 'preparing'
  | 'waiting'
  | 'uploading'
  | 'processing'
  | 'success'
  | 'failed';
type QueueItem = {
  id: string;
  name: string;
  size: number;
  source: 'local' | 'remote' | 'paste';
  status: QueueStatus;
  progress: number;
  url?: string;
  error?: string;
  file?: File;
  remoteUrl?: string;
  storageProvider: StorageProvider;
  visibility: Visibility;
};

const albums = ref<Album[]>([]);
const queue = ref<QueueItem[]>([]);
const remoteUrls = ref('');
const remoteFilename = ref('');
const setting = ref<UploadPolicy | null>(null);
const outputFormat = ref<'url' | 'markdown' | 'html' | 'bbcode'>('url');
const form = reactive({
  albumId: '',
  visibility: 'PRIVATE' as Visibility,
  storageProvider: 'S3' as StorageProvider,
});

const albumOptions = computed(() => [
  { id: '', name: '不加入相册' },
  ...albums.value,
]);
const activeCount = computed(
  () =>
    queue.value.filter((item) =>
      ['waiting', 'preparing', 'uploading', 'processing'].includes(item.status),
    ).length,
);
const successItems = computed(() =>
  queue.value.filter((item) => item.status === 'success' && item.url),
);
const failedItems = computed(() =>
  queue.value.filter((item) => item.status === 'failed'),
);
const totalBytes = computed(() =>
  queue.value.reduce((sum, item) => sum + item.size, 0),
);
const outputText = computed(() =>
  successItems.value
    .map((item) => formatResult(item, outputFormat.value))
    .join('\n'),
);
const storageTargetOptions = [
  { label: '第三方对象存储', value: 'S3' },
  { label: '本机存储', value: 'LOCAL' },
] as const;
const storageTargetLabel = computed(() =>
  form.storageProvider === 'LOCAL' ? '本机存储' : '第三方对象存储',
);

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatResult(
  item: QueueItem,
  format: 'url' | 'markdown' | 'html' | 'bbcode',
) {
  const url = toAbsoluteUrl(item.url);
  if (format === 'markdown') return `![${item.name}](${url})`;
  if (format === 'html') return `<img src="${url}" alt="${item.name}">`;
  if (format === 'bbcode') return `[img]${url}[/img]`;
  return url;
}

function validateFile(file: File) {
  if (!file.type.startsWith('image/')) {
    ElMessage.error(`${file.name} 不是图片文件`);
    return false;
  }

  if (
    setting.value?.allowedTypes?.length &&
    !setting.value.allowedTypes.includes(file.type)
  ) {
    ElMessage.error(`当前不允许上传 ${file.type}`);
    return false;
  }

  const maxSizeMb = setting.value?.maxSizeMb ?? 50;
  if (file.size > maxSizeMb * 1024 * 1024) {
    ElMessage.error(`${file.name} 超过 ${maxSizeMb} MB`);
    return false;
  }

  return true;
}

async function runLocalUpload(item: QueueItem) {
  if (!item.file) return;
  item.status = 'preparing';
  item.progress = 5;

  const signed = await signUploadApi({
    filename: item.file.name,
    contentType: item.file.type || 'application/octet-stream',
    sizeBytes: item.file.size,
    albumId: form.albumId || undefined,
    visibility: item.visibility,
    storageProvider: item.storageProvider,
  });

  item.status = 'uploading';
  item.progress = 10;
  await putObject(signed.uploadUrl, item.file, signed.headers, (percent) => {
    item.progress = Math.max(10, Math.min(85, Math.round(percent * 0.75 + 10)));
  });
  item.status = 'processing';
  item.progress = 90;
  const image = await completeUploadApi(signed.imageId);
  item.status = 'success';
  item.progress = 100;
  item.url =
    image.status === 'READY' && image.visibility !== 'PRIVATE'
      ? toAbsoluteUrl(image.publicUrl)
      : '';
}

async function runRemoteImport(item: QueueItem) {
  if (!item.remoteUrl) return;
  item.status = 'preparing';
  item.progress = 5;
  const image = await importUrlApi({
    url: item.remoteUrl,
    filename: remoteFilename.value.trim() || undefined,
    albumId: form.albumId || undefined,
    visibility: item.visibility,
    storageProvider: item.storageProvider,
  });
  item.status = 'success';
  item.progress = 100;
  item.name = image.originalName;
  item.size = image.sizeBytes;
  item.url =
    image.status === 'READY' && image.visibility !== 'PRIVATE'
      ? toAbsoluteUrl(image.publicUrl)
      : '';
}

async function runQueueItem(item: QueueItem) {
  try {
    item.error = '';
    if (item.source === 'remote') {
      await runRemoteImport(item);
    } else {
      await runLocalUpload(item);
    }
  } catch (error) {
    item.status = 'failed';
    item.error = error instanceof Error ? error.message : '上传失败';
  }
}

async function enqueueFiles(
  files: File[],
  source: 'local' | 'paste' = 'local',
) {
  const nextItems = files.filter(validateFile).map((file) => ({
    id: makeId(),
    name: file.name,
    size: file.size,
    source,
    storageProvider: form.storageProvider,
    visibility: form.visibility,
    status: 'waiting' as QueueStatus,
    progress: 0,
    file,
  }));

  queue.value.unshift(...nextItems);
  for (const item of nextItems) {
    await runQueueItem(item);
  }
}

async function uploadFile(options: UploadRequestOptions) {
  const file = options.file as UploadRawFile;
  const item: QueueItem = {
    id: makeId(),
    name: file.name,
    size: file.size,
    source: 'local',
    storageProvider: form.storageProvider,
    visibility: form.visibility,
    status: 'waiting',
    progress: 0,
    file,
  };
  if (!validateFile(file)) {
    options.onError?.(new Error('invalid file') as never);
    return;
  }

  queue.value.unshift(item);
  await runQueueItem(item);
  if (item.status === 'success') {
    options.onSuccess?.({});
    ElMessage.success(`${file.name} 上传完成`);
  } else {
    options.onError?.(new Error(item.error || '上传失败') as never);
  }
}

function beforeUpload(file: UploadRawFile) {
  return validateFile(file);
}

async function importRemoteUrls() {
  const urls = remoteUrls.value
    .split(/\n+/)
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) {
    ElMessage.warning('请输入远程图片 URL');
    return;
  }

  const items: QueueItem[] = urls.map((url) => ({
    id: makeId(),
    name: url.split('/').filter(Boolean).pop() || url,
    size: 0,
    source: 'remote',
    storageProvider: form.storageProvider,
    visibility: form.visibility,
    status: 'waiting',
    progress: 0,
    remoteUrl: url,
  }));

  queue.value.unshift(...items);
  for (const item of items) {
    await runQueueItem(item);
  }
  remoteUrls.value = '';
  remoteFilename.value = '';
}

async function retry(item: QueueItem) {
  item.status = 'waiting';
  item.progress = 0;
  await runQueueItem(item);
}

function removeItem(id: string) {
  queue.value = queue.value.filter((item) => item.id !== id);
}

function clearFinished() {
  queue.value = queue.value.filter(
    (item) => !['success', 'failed'].includes(item.status),
  );
}

async function copyText(value: string, label = '内容') {
  if (!value) return;
  if (!(await copyToClipboard(value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success(`${label}已复制`);
}

async function handlePaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );

  if (!files.length) return;
  await enqueueFiles(files, 'paste');
  ElMessage.success(`已从剪贴板上传 ${files.length} 张图片`);
}

function statusType(status: QueueStatus) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'processing') return 'warning';
  return 'info';
}

function statusLabel(status: QueueStatus) {
  return {
    preparing: '准备中',
    waiting: '等待',
    uploading: '上传中',
    processing: '处理中',
    success: '完成',
    failed: '失败',
  }[status];
}

onMounted(async () => {
  const [albumData, settingData] = await Promise.all([
    listAlbumsApi(),
    getUploadPolicyApi(),
  ]);
  albums.value = albumData;
  setting.value = settingData;
  form.visibility = settingData.defaultVisibility;
  form.storageProvider = settingData.storageProvider;
  window.addEventListener('paste', handlePaste);
});

onUnmounted(() => {
  window.removeEventListener('paste', handlePaste);
});
</script>

<template>
  <div class="upload-workbench">
    <section class="upload-main">
      <el-card shadow="never" class="upload-card">
        <template #header>
          <div class="panel-head">
            <strong>上传工作台</strong>
            <el-tag type="success">{{ storageTargetLabel }}</el-tag>
          </div>
        </template>

        <div class="upload-options">
          <el-form label-position="top">
            <el-form-item label="目标相册">
              <el-select v-model="form.albumId" class="full-width">
                <el-option
                  v-for="album in albumOptions"
                  :key="album.id"
                  :label="album.name"
                  :value="album.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="存储目标">
              <el-segmented
                v-model="form.storageProvider"
                :options="storageTargetOptions"
              />
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
        </div>

        <el-upload
          drag
          multiple
          :show-file-list="false"
          :http-request="uploadFile"
          :before-upload="beforeUpload"
          class="uploader"
        >
          <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
          <div class="el-upload__text">
            拖拽图片到这里，点击选择，或直接粘贴截图
          </div>
          <template #tip>
            <div class="el-upload__tip">
              当前存储 {{ storageTargetLabel }}；允许类型
              {{ setting?.allowedTypes?.join(', ') || 'image/*' }}；单张最大
              {{ formatBytes((setting?.maxSizeMb ?? 50) * 1024 * 1024) }}
            </div>
          </template>
        </el-upload>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>远程 URL 导入</strong>
            <div class="header-actions">
              <el-tag>{{ storageTargetLabel }}</el-tag>
              <el-button type="primary" :icon="Link" @click="importRemoteUrls"
                >导入</el-button
              >
            </div>
          </div>
        </template>
        <el-input
          v-model="remoteUrls"
          type="textarea"
          :rows="6"
          placeholder="每行一个远程图片 URL"
        />
        <div class="remote-import compact">
          <el-input
            v-model="remoteFilename"
            placeholder="单 URL 导入时可自定义文件名"
          />
          <el-button :icon="Files" @click="importRemoteUrls"
            >加入队列</el-button
          >
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>上传队列</strong>
            <div class="header-actions">
              <el-tag>{{ queue.length }} 项</el-tag>
              <el-button size="small" :icon="Refresh" @click="clearFinished"
                >清理完成项</el-button
              >
            </div>
          </div>
        </template>

        <el-empty v-if="!queue.length" description="暂无上传任务" />
        <div v-else class="queue-list">
          <div v-for="item in queue" :key="item.id" class="queue-item">
            <div class="queue-state">
              <el-icon v-if="item.status === 'success'"><Check /></el-icon>
              <el-icon v-else-if="item.status === 'failed'"
                ><CircleClose
              /></el-icon>
              <el-icon v-else><UploadFilled /></el-icon>
            </div>
            <div class="queue-body">
              <div class="queue-title">
                <strong>{{ item.name }}</strong>
                <el-tag size="small" :type="statusType(item.status)">
                  {{ statusLabel(item.status) }}
                </el-tag>
              </div>
              <span>
                {{
                  item.storageProvider === 'LOCAL'
                    ? '本机存储'
                    : '第三方对象存储'
                }}
                ·
                {{
                  item.source === 'remote'
                    ? item.remoteUrl
                    : formatBytes(item.size)
                }}
              </span>
              <el-progress
                :percentage="item.progress"
                :status="item.status === 'failed' ? 'exception' : undefined"
              />
              <p v-if="item.error">{{ item.error }}</p>
            </div>
            <div class="queue-actions">
              <el-button
                v-if="item.url"
                size="small"
                :icon="CopyDocument"
                @click="copyText(item.url, '外链')"
              />
              <el-button
                v-if="item.status === 'failed'"
                size="small"
                @click="retry(item)"
                >重试</el-button
              >
              <el-button size="small" text @click="removeItem(item.id)"
                >移除</el-button
              >
            </div>
          </div>
        </div>
      </el-card>
    </section>

    <aside class="upload-side">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>本次统计</strong>
          </div>
        </template>
        <div class="variant-grid">
          <div>
            <strong>{{ queue.length }}</strong>
            <span>任务</span>
          </div>
          <div>
            <strong>{{ successItems.length }}</strong>
            <span>成功</span>
          </div>
          <div>
            <strong>{{ failedItems.length }}</strong>
            <span>失败</span>
          </div>
        </div>
        <div class="feature-list upload-summary">
          <div>
            <strong>{{ activeCount }}</strong>
            <span>进行中</span>
          </div>
          <div>
            <strong>{{ formatBytes(totalBytes) }}</strong>
            <span>本次文件量</span>
          </div>
          <div>
            <strong>{{ storageTargetLabel }}</strong>
            <span>当前目标</span>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>结果复制</strong>
            <el-button
              v-if="outputText"
              size="small"
              :icon="CopyDocument"
              @click="copyText(outputText, '上传结果')"
            />
          </div>
        </template>
        <el-segmented
          v-model="outputFormat"
          :options="[
            { label: 'URL', value: 'url' },
            { label: 'Markdown', value: 'markdown' },
            { label: 'HTML', value: 'html' },
            { label: 'BBCode', value: 'bbcode' },
          ]"
        />
        <el-input
          class="result-output"
          :model-value="outputText"
          type="textarea"
          :rows="12"
          readonly
        />
      </el-card>
    </aside>
  </div>
</template>
