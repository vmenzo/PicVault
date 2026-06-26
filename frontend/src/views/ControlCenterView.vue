<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { listAlbumsApi } from '@/api/albums';
import {
  getAppSettingApi,
  testEmailApi,
  testStorageApi,
  updateAppSettingApi,
} from '@/api/settings';
import { getTelegramStatusApi } from '@/api/telegram';
import { useAuthStore } from '@/stores/auth';
import type { Album, StorageProvider, Visibility } from '@/api/types';

const auth = useAuthStore();
const loading = ref(false);
const saving = ref(false);
const testingStorage = ref(false);
const testingEmail = ref(false);
const albums = ref<Album[]>([]);
const telegramConfigured = ref(false);
const currentOrigin = window.location.origin;
const defaultPublicBaseUrl = '';
const localPublicBaseUrl = `${window.location.origin}/api/public/files`;

const storage = reactive({
  publicBaseUrl: defaultPublicBaseUrl,
  provider: 'S3' as StorageProvider,
  localStoragePath: '/app/backend/storage',
  s3Endpoint: '',
  s3Region: 'us-east-1',
  s3Bucket: '',
  s3AccessKey: '',
  s3SecretKey: '',
  s3ForcePathStyle: true,
  maxSizeMb: 50,
  defaultQuotaMb: 1024,
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  defaultVisibility: 'PRIVATE' as Visibility,
});

const site = reactive({
  appPublicUrl: currentOrigin,
});

const processing = reactive({
  thumbnail: true,
  webp: true,
  avif: false,
  stripMetadata: true,
  watermark: false,
  watermarkText: 'PicVault',
});

const security = reactive({
  hotlinkProtection: false,
  uploadAudit: false,
  apiUpload: true,
});

const telegram = reactive({
  enabled: false,
  token: '',
  allowedChatIdsText: '',
  albumId: '',
  lastUpdateId: null as number | null,
});

const email = reactive({
  enabled: false,
  host: '',
  port: 465,
  secure: true,
  username: '',
  password: '',
  from: '',
  testTo: '',
});
const storageProviderLabel = computed(() =>
  storage.provider === 'LOCAL' ? '本机目录' : '第三方对象存储',
);

const storagePresets = [
  {
    label: 'Cloudflare R2',
    endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
    region: 'auto',
    forcePathStyle: true,
  },
  {
    label: 'AWS S3',
    endpoint: 'https://s3.<region>.amazonaws.com',
    region: 'us-east-1',
    forcePathStyle: false,
  },
  {
    label: '阿里 OSS S3',
    endpoint: 'https://oss-<region>.aliyuncs.com',
    region: 'oss-cn-hangzhou',
    forcePathStyle: false,
  },
  {
    label: '腾讯 COS S3',
    endpoint: 'https://cos.<region>.myqcloud.com',
    region: 'ap-shanghai',
    forcePathStyle: false,
  },
] as const;

function applyStoragePreset(preset: (typeof storagePresets)[number]) {
  storage.s3Endpoint = preset.endpoint;
  storage.s3Region = preset.region;
  storage.s3ForcePathStyle = preset.forcePathStyle;
}

function cleanS3Credential(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

async function load() {
  loading.value = true;
  try {
    const [data, albumList, botStatus] = await Promise.all([
      getAppSettingApi(),
      listAlbumsApi(),
      getTelegramStatusApi().catch(() => null),
    ]);

    albums.value = albumList;
    storage.publicBaseUrl =
      data.publicBaseUrl ??
      (data.storageProvider === 'LOCAL'
        ? localPublicBaseUrl
        : defaultPublicBaseUrl);
    storage.provider = data.storageProvider;
    storage.localStoragePath =
      data.localStoragePath || storage.localStoragePath;
    storage.s3Endpoint = data.s3Endpoint || storage.s3Endpoint;
    storage.s3Region = data.s3Region || storage.s3Region;
    storage.s3Bucket = data.s3Bucket || storage.s3Bucket;
    storage.s3AccessKey = data.s3AccessKey || '';
    storage.s3SecretKey = data.s3SecretKey || '';
    storage.s3ForcePathStyle = data.s3ForcePathStyle;
    storage.maxSizeMb = data.maxSizeMb;
    storage.defaultQuotaMb = data.defaultQuotaMb;
    storage.allowedTypes = data.allowedTypes;
    storage.defaultVisibility = data.defaultVisibility;
    processing.thumbnail = data.generateThumbnail;
    processing.webp = data.generateWebp;
    processing.avif = data.generateAvif;
    processing.stripMetadata = data.stripMetadata;
    processing.watermark = data.watermark;
    processing.watermarkText = data.watermarkText;
    security.hotlinkProtection = data.hotlinkProtection;
    security.uploadAudit = data.uploadAudit;
    security.apiUpload = data.apiUpload;
    site.appPublicUrl = data.appPublicUrl || currentOrigin;
    telegram.enabled = data.telegramBotEnabled;
    telegram.token = data.telegramBotToken || '';
    telegram.allowedChatIdsText = data.telegramAllowedChatIds.join('\n');
    telegram.albumId = data.telegramAlbumId || '';
    telegram.lastUpdateId = data.telegramLastUpdateId ?? null;
    email.enabled = data.smtpEnabled;
    email.host = data.smtpHost || '';
    email.port = data.smtpPort || (data.smtpSecure ? 465 : 587);
    email.secure = data.smtpSecure;
    email.username = data.smtpUsername || '';
    email.password = data.smtpPassword || '';
    email.from = data.smtpFrom || '';
    email.testTo = auth.user?.email || '';
    telegramConfigured.value = Boolean(
      botStatus?.accounts.some((account) => account.configured),
    );
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    storage.s3AccessKey = cleanS3Credential(storage.s3AccessKey);
    storage.s3SecretKey = cleanS3Credential(storage.s3SecretKey);

    await updateAppSettingApi({
      publicBaseUrl: storage.publicBaseUrl || null,
      appPublicUrl: site.appPublicUrl || null,
      storageProvider: storage.provider,
      localStoragePath: storage.localStoragePath || null,
      s3Endpoint: storage.s3Endpoint || null,
      s3Region: storage.s3Region || null,
      s3Bucket: storage.s3Bucket || null,
      s3AccessKey: storage.s3AccessKey || null,
      s3SecretKey: storage.s3SecretKey || null,
      s3ForcePathStyle: storage.s3ForcePathStyle,
      maxSizeMb: storage.maxSizeMb,
      defaultQuotaMb: storage.defaultQuotaMb,
      allowedTypes: storage.allowedTypes,
      defaultVisibility: storage.defaultVisibility,
      generateThumbnail: processing.thumbnail,
      generateWebp: processing.webp,
      generateAvif: processing.avif,
      stripMetadata: processing.stripMetadata,
      watermark: processing.watermark,
      watermarkText: processing.watermarkText,
      hotlinkProtection: security.hotlinkProtection,
      uploadAudit: security.uploadAudit,
      apiUpload: security.apiUpload,
      telegramBotEnabled: telegram.enabled,
      telegramBotToken: telegram.token || null,
      telegramAllowedChatIds: telegram.allowedChatIdsText
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
      telegramAlbumId: telegram.albumId || null,
      smtpEnabled: email.enabled,
      smtpHost: email.host || null,
      smtpPort: email.port || null,
      smtpSecure: email.secure,
      smtpUsername: email.username || null,
      smtpPassword: email.password || null,
      smtpFrom: email.from || null,
    });
    ElMessage.success('配置已保存');
    await load();
  } finally {
    saving.value = false;
  }
}

async function handleSaveClick() {
  try {
    await save();
  } catch {
    // 错误详情已由 http 拦截器统一弹出。
  }
}

async function testEmail() {
  if (!email.testTo) {
    ElMessage.warning('请填写测试收件邮箱');
    return;
  }

  testingEmail.value = true;
  try {
    await save();
    await testEmailApi({ email: email.testTo });
    ElMessage.success('测试邮件已发送');
  } catch {
    // 错误详情已由 http 拦截器统一弹出。
  } finally {
    testingEmail.value = false;
  }
}

async function testStorage() {
  testingStorage.value = true;
  try {
    await save();
    const result = await testStorageApi();
    ElMessage.success(
      result.provider === 'LOCAL'
        ? '本机存储配置可用'
        : `第三方对象存储连接成功：${result.bucket || 'bucket 已验证'}`,
    );
  } catch {
    // 错误详情已由 http 拦截器统一弹出，这里仅吞掉异常避免触发全局错误处理。
  } finally {
    testingStorage.value = false;
  }
}

onMounted(load);

watch(
  () => storage.provider,
  (provider) => {
    if (provider === 'LOCAL') {
      if (!storage.publicBaseUrl) {
        storage.publicBaseUrl = localPublicBaseUrl;
      }
      return;
    }

    if (storage.publicBaseUrl === localPublicBaseUrl) {
      storage.publicBaseUrl = '';
    }
  },
);
</script>

<template>
  <div class="page-stack" v-loading="loading">
    <div class="page-actions">
      <el-button type="primary" :loading="saving" @click="handleSaveClick"
        >保存全部配置</el-button
      >
    </div>

    <section class="settings-grid wide">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>存储驱动</strong>
            <el-tag>{{ storageProviderLabel }}</el-tag>
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="驱动">
            <el-segmented
              v-model="storage.provider"
              :options="[
                { label: '第三方对象存储', value: 'S3' },
                { label: '本机存储', value: 'LOCAL' },
              ]"
            />
          </el-form-item>
          <el-form-item
            :label="
              storage.provider === 'LOCAL'
                ? '公开访问地址'
                : '公开访问域名 / CDN 域名'
            "
          >
            <el-input
              v-model="storage.publicBaseUrl"
              :placeholder="
                storage.provider === 'LOCAL'
                  ? localPublicBaseUrl
                  : 'https://cdn.example.com 或对象存储公开域名'
              "
            >
              <template #append>
                <el-button
                  @click="
                    storage.publicBaseUrl =
                      storage.provider === 'LOCAL'
                        ? localPublicBaseUrl
                        : currentOrigin
                  "
                >
                  当前域名
                </el-button>
              </template>
            </el-input>
          </el-form-item>

          <template v-if="storage.provider === 'S3'">
            <el-alert
              class="settings-hint"
              type="info"
              show-icon
              :closable="false"
              title="填写第三方 S3 兼容对象存储配置，例如 Cloudflare R2、AWS S3、阿里云 OSS S3、腾讯 COS S3 或七牛 Kodo S3。Bucket 需要允许浏览器 PUT 的 CORS。"
            />
            <div class="preset-row">
              <el-button
                v-for="preset in storagePresets"
                :key="preset.label"
                size="small"
                @click="applyStoragePreset(preset)"
              >
                {{ preset.label }}
              </el-button>
            </div>
            <div class="form-grid two">
              <el-form-item label="Endpoint">
                <el-input
                  v-model="storage.s3Endpoint"
                  placeholder="https://s3.example.com"
                />
              </el-form-item>
              <el-form-item label="Bucket">
                <el-input
                  v-model="storage.s3Bucket"
                  placeholder="picvault-assets"
                />
              </el-form-item>
              <el-form-item label="Region">
                <el-input
                  v-model="storage.s3Region"
                  placeholder="auto / us-east-1 / oss-cn-hangzhou"
                />
              </el-form-item>
              <el-form-item label="Access Key">
                <el-input v-model="storage.s3AccessKey" show-password />
              </el-form-item>
              <el-form-item label="Secret Key">
                <el-input v-model="storage.s3SecretKey" show-password />
              </el-form-item>
              <el-form-item label="Path Style">
                <el-switch
                  v-model="storage.s3ForcePathStyle"
                  active-text="启用"
                />
              </el-form-item>
            </div>
          </template>

          <template v-else>
            <el-form-item label="本机存储目录">
              <el-input v-model="storage.localStoragePath" />
            </el-form-item>
          </template>

          <div class="form-actions">
            <el-button :loading="testingStorage" @click="testStorage">
              测试当前存储
            </el-button>
          </div>
        </el-form>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>容量与上传策略</strong>
          </div>
        </template>
        <el-form label-position="top">
          <div class="form-grid two">
            <el-form-item label="单文件大小">
              <el-input-number
                v-model="storage.maxSizeMb"
                :min="1"
                :max="500"
              />
            </el-form-item>
            <el-form-item label="新用户默认总容量">
              <el-input-number
                v-model="storage.defaultQuotaMb"
                :min="1"
                :max="1024 * 1024"
              />
            </el-form-item>
            <el-form-item label="默认可见性">
              <el-select v-model="storage.defaultVisibility" class="full-width">
                <el-option label="私有" value="PRIVATE" />
                <el-option label="公开" value="PUBLIC" />
                <el-option label="隐藏链接" value="UNLISTED" />
              </el-select>
            </el-form-item>
          </div>
          <el-form-item label="允许类型">
            <el-select
              v-model="storage.allowedTypes"
              multiple
              class="full-width"
            >
              <el-option label="JPEG" value="image/jpeg" />
              <el-option label="PNG" value="image/png" />
              <el-option label="WebP" value="image/webp" />
              <el-option label="GIF" value="image/gif" />
              <el-option label="AVIF" value="image/avif" />
            </el-select>
          </el-form-item>
        </el-form>
      </el-card>
    </section>

    <section class="settings-grid wide">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>Telegram Bot</strong>
            <el-tag :type="telegram.enabled ? 'success' : 'info'">
              {{ telegram.enabled ? '已启用' : '未启用' }}
            </el-tag>
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="状态">
            <div class="inline-status">
              <el-switch
                v-model="telegram.enabled"
                active-text="启用 Bot 上传"
              />
              <el-tag :type="telegramConfigured ? 'success' : 'warning'">
                {{ telegramConfigured ? 'Token 已配置' : 'Token 未配置' }}
              </el-tag>
            </div>
          </el-form-item>
          <el-form-item label="Bot Token">
            <el-input v-model="telegram.token" show-password />
          </el-form-item>
          <el-form-item label="允许的 Chat ID">
            <el-input
              v-model="telegram.allowedChatIdsText"
              type="textarea"
              :rows="4"
              placeholder="每行一个 Chat ID；留空表示不限制"
            />
          </el-form-item>
          <el-form-item label="默认相册">
            <el-select v-model="telegram.albumId" clearable class="full-width">
              <el-option
                v-for="album in albums"
                :key="album.id"
                :label="album.name"
                :value="album.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="站点公开域名 / Telegram 外链域名">
            <el-input
              v-model="site.appPublicUrl"
              placeholder="https://img.example.com"
            >
              <template #append>
                <el-button @click="site.appPublicUrl = currentOrigin">
                  当前域名
                </el-button>
              </template>
            </el-input>
            <div class="form-help">
              通过反向代理访问时填写最终公网 HTTPS 域名，Telegram
              上传完成后的图片链接和分享页会使用这里。
            </div>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>图片处理与安全</strong>
          </div>
        </template>
        <div class="settings-toggles dense">
          <el-switch v-model="processing.thumbnail" active-text="生成缩略图" />
          <el-switch v-model="processing.webp" active-text="生成 WebP" />
          <el-switch v-model="processing.avif" active-text="生成 AVIF" />
          <el-switch
            v-model="processing.stripMetadata"
            active-text="清理 EXIF"
          />
          <el-switch v-model="processing.watermark" active-text="水印" />
          <el-switch
            v-model="security.hotlinkProtection"
            active-text="防盗链"
          />
          <el-switch v-model="security.uploadAudit" active-text="上传审核" />
          <el-switch v-model="security.apiUpload" active-text="允许 API 上传" />
        </div>
        <el-form label-position="top" class="settings-followup">
          <el-form-item v-if="processing.watermark" label="水印文字">
            <el-input v-model="processing.watermarkText" />
          </el-form-item>
          <el-form-item label="Telegram 最后更新 ID">
            <el-input :model-value="telegram.lastUpdateId ?? '暂无'" disabled />
          </el-form-item>
        </el-form>
      </el-card>
    </section>

    <section class="settings-grid wide">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>邮件与找回密码</strong>
            <el-tag :type="email.enabled ? 'success' : 'info'">
              {{ email.enabled ? '已启用' : '未启用' }}
            </el-tag>
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="状态">
            <el-switch v-model="email.enabled" active-text="启用 SMTP 邮件" />
          </el-form-item>
          <div class="form-grid two">
            <el-form-item label="SMTP Host">
              <el-input v-model="email.host" placeholder="smtp.example.com" />
            </el-form-item>
            <el-form-item label="SMTP Port">
              <el-input-number v-model="email.port" :min="1" :max="65535" />
            </el-form-item>
            <el-form-item label="安全连接">
              <el-switch v-model="email.secure" active-text="SSL / TLS" />
            </el-form-item>
            <el-form-item label="发件人">
              <el-input
                v-model="email.from"
                placeholder="PicVault <no-reply@example.com>"
              />
            </el-form-item>
            <el-form-item label="SMTP 用户名">
              <el-input v-model="email.username" autocomplete="off" />
            </el-form-item>
            <el-form-item label="SMTP 密码">
              <el-input
                v-model="email.password"
                type="password"
                show-password
                autocomplete="new-password"
              />
            </el-form-item>
          </div>
          <div class="form-grid two">
            <el-form-item label="测试收件邮箱">
              <el-input
                v-model.trim="email.testTo"
                placeholder="admin@example.com"
              />
            </el-form-item>
          </div>
          <div class="form-actions">
            <el-button :loading="testingEmail" @click="testEmail"
              >发送测试邮件</el-button
            >
          </div>
        </el-form>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>密码重置安全策略</strong>
          </div>
        </template>
        <div class="policy-list">
          <span>重置链接 30 分钟有效</span>
          <span>Token 只保存哈希且一次性使用</span>
          <span>申请接口不暴露邮箱是否存在</span>
          <span>改密后旧登录态自动失效</span>
        </div>
      </el-card>
    </section>
  </div>
</template>
