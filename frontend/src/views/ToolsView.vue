<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  CopyDocument,
  Crop,
  Download,
  MagicStick,
  Refresh,
  UploadFilled,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { copyToClipboard } from '@/utils/clipboard';
import { formatBytes } from '@/utils/format';

const sourceFile = ref<File | null>(null);
const sourceUrl = ref('');
const outputUrl = ref('');
const outputBlob = ref<Blob | null>(null);
const base64Output = ref('');
const processing = ref(false);
const options = ref({
  width: 1200,
  height: 0,
  quality: 0.82,
  format: 'image/webp',
  keepRatio: true,
});

const sourceSize = computed(() => sourceFile.value?.size ?? 0);
const outputSize = computed(() => outputBlob.value?.size ?? 0);
const savedPercent = computed(() => {
  if (!sourceSize.value || !outputSize.value) return 0;
  return Math.max(
    0,
    Math.round((1 - outputSize.value / sourceSize.value) * 100),
  );
});
const canProcess = computed(() => Boolean(sourceFile.value && sourceUrl.value));

function loadFile(file: File) {
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请选择图片文件');
    return;
  }

  sourceFile.value = file;
  sourceUrl.value = URL.createObjectURL(file);
  outputUrl.value = '';
  outputBlob.value = null;
  base64Output.value = '';
}

function handleInput(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) loadFile(file);
}

async function processImage() {
  if (!sourceUrl.value) return;
  processing.value = true;
  try {
    const image = await createImageBitmap(sourceFile.value as File);
    const targetWidth = options.value.width || image.width;
    const targetHeight = options.value.keepRatio
      ? Math.round((targetWidth / image.width) * image.height)
      : options.value.height || image.height;
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 不可用');
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (nextBlob) => {
          if (nextBlob) resolve(nextBlob);
          else reject(new Error('图片处理失败'));
        },
        options.value.format,
        options.value.quality,
      );
    });

    if (outputUrl.value) URL.revokeObjectURL(outputUrl.value);
    outputBlob.value = blob;
    outputUrl.value = URL.createObjectURL(blob);
    base64Output.value = canvas.toDataURL(
      options.value.format,
      options.value.quality,
    );
    ElMessage.success('处理完成');
  } finally {
    processing.value = false;
  }
}

function downloadOutput() {
  if (!outputBlob.value) return;
  const extension = options.value.format.split('/')[1] || 'png';
  const link = document.createElement('a');
  link.href = outputUrl.value;
  link.download = `${sourceFile.value?.name.replace(/\.[^/.]+$/, '') || 'image'}.${extension}`;
  link.click();
}

async function copyBase64() {
  if (!base64Output.value) return;
  if (!(await copyToClipboard(base64Output.value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success('Base64 已复制');
}

function reset() {
  sourceFile.value = null;
  sourceUrl.value = '';
  outputUrl.value = '';
  outputBlob.value = null;
  base64Output.value = '';
}
</script>

<template>
  <div class="tool-workbench">
    <section class="tool-preview">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>本地图片工具箱</strong>
            <div class="header-actions">
              <el-button :icon="Refresh" @click="reset">重置</el-button>
              <label class="file-button">
                <el-icon><UploadFilled /></el-icon>
                <span>选择图片</span>
                <input type="file" accept="image/*" @change="handleInput" />
              </label>
            </div>
          </div>
        </template>

        <div class="compare-grid">
          <div class="compare-panel">
            <div class="compare-head">
              <strong>原图</strong>
              <span>{{ sourceFile?.name || '未选择' }}</span>
            </div>
            <div class="tool-canvas">
              <img v-if="sourceUrl" :src="sourceUrl" alt="source" />
              <el-empty v-else description="选择一张图片开始处理" />
            </div>
          </div>

          <div class="compare-panel">
            <div class="compare-head">
              <strong>输出</strong>
              <span>{{
                outputBlob ? formatBytes(outputBlob.size) : '等待处理'
              }}</span>
            </div>
            <div class="tool-canvas">
              <img v-if="outputUrl" :src="outputUrl" alt="output" />
              <el-empty v-else description="处理后显示结果" />
            </div>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>Base64 输出</strong>
            <el-button
              v-if="base64Output"
              size="small"
              :icon="CopyDocument"
              @click="copyBase64"
            />
          </div>
        </template>
        <el-input
          :model-value="base64Output"
          type="textarea"
          :rows="6"
          readonly
        />
      </el-card>
    </section>

    <aside class="tool-side">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>处理参数</strong>
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="输出格式">
            <el-segmented
              v-model="options.format"
              :options="[
                { label: 'WebP', value: 'image/webp' },
                { label: 'PNG', value: 'image/png' },
                { label: 'JPEG', value: 'image/jpeg' },
              ]"
            />
          </el-form-item>
          <el-form-item label="宽度">
            <el-input-number v-model="options.width" :min="1" :max="8000" />
          </el-form-item>
          <el-form-item label="高度">
            <el-input-number
              v-model="options.height"
              :min="0"
              :max="8000"
              :disabled="options.keepRatio"
            />
          </el-form-item>
          <el-form-item label="保持比例">
            <el-switch v-model="options.keepRatio" />
          </el-form-item>
          <el-form-item label="质量">
            <el-slider
              v-model="options.quality"
              :min="0.1"
              :max="1"
              :step="0.01"
            />
          </el-form-item>
        </el-form>
        <div class="drawer-actions">
          <el-button
            type="primary"
            :icon="MagicStick"
            :loading="processing"
            :disabled="!canProcess"
            @click="processImage"
          >
            处理图片
          </el-button>
          <el-button
            :icon="Download"
            :disabled="!outputBlob"
            @click="downloadOutput"
            >下载</el-button
          >
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>结果统计</strong>
          </div>
        </template>
        <div class="variant-grid">
          <div>
            <strong>{{ formatBytes(sourceSize) }}</strong>
            <span>原始大小</span>
          </div>
          <div>
            <strong>{{ formatBytes(outputSize) }}</strong>
            <span>输出大小</span>
          </div>
          <div>
            <strong>{{ savedPercent }}%</strong>
            <span>节省</span>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>常用工具</strong>
          </div>
        </template>
        <div class="feature-list">
          <div>
            <strong
              ><el-icon><Crop /></el-icon> 缩放压缩</strong
            >
            <span>按宽高输出适合博客、论坛、头像的图片</span>
          </div>
          <div>
            <strong
              ><el-icon><MagicStick /></el-icon> 格式转换</strong
            >
            <span>在浏览器内转换 WebP、PNG、JPEG</span>
          </div>
          <div>
            <strong
              ><el-icon><CopyDocument /></el-icon> Base64</strong
            >
            <span>生成可直接嵌入页面的小图字符串</span>
          </div>
        </div>
      </el-card>
    </aside>
  </div>
</template>
