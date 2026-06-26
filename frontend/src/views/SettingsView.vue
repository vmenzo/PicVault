<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  CopyDocument,
  Delete,
  Key,
  Lock,
  SwitchButton,
  Plus,
  Refresh,
  User,
  Wallet,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import { changePasswordApi } from '@/api/auth';
import {
  createApiKeyApi,
  deleteApiKeyApi,
  listApiKeysApi,
} from '@/api/apiKeys';
import type { ApiKey } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { copyToClipboard } from '@/utils/clipboard';
import { formatBytes, formatDate } from '@/utils/format';

const auth = useAuthStore();
const loading = ref(false);
const apiKeys = ref<ApiKey[]>([]);
const dialogVisible = ref(false);
const createdKey = ref('');
const profileForm = reactive({
  name: '',
  email: '',
});
const keyForm = reactive({
  name: 'CLI uploader',
});
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
});

const usage = computed(() => {
  const user = auth.user;
  if (!user || !user.quotaBytes) return 0;
  return Math.min(Math.round((user.usedBytes / user.quotaBytes) * 100), 100);
});
const availableBytes = computed(() =>
  Math.max((auth.user?.quotaBytes ?? 0) - (auth.user?.usedBytes ?? 0), 0),
);
const apiExample = computed(
  () => `curl -H "X-API-Key: ${createdKey.value || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  ${window.location.origin}/api/images`,
);

async function load() {
  loading.value = true;
  try {
    await auth.loadProfile();
    profileForm.name = auth.user?.name ?? '';
    profileForm.email = auth.user?.email ?? '';
    apiKeys.value = await listApiKeysApi();
  } finally {
    loading.value = false;
  }
}

async function saveProfile() {
  await auth.updateProfile({
    name: profileForm.name,
    email: profileForm.email,
  });
  profileForm.email = auth.user?.email ?? '';
  profileForm.name = auth.user?.name ?? '';
  ElMessage.success('资料已保存');
}

async function changePassword() {
  await changePasswordApi({
    currentPassword: passwordForm.currentPassword,
    newPassword: passwordForm.newPassword,
  });
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  ElMessage.success('密码已更新');
}

async function createKey() {
  const key = await createApiKeyApi({ name: keyForm.name });
  createdKey.value = key.key ?? '';
  dialogVisible.value = false;
  ElMessage.success('API Key 已创建');
  await load();
}

async function removeKey(key: ApiKey) {
  await ElMessageBox.confirm(`确定删除 ${key.name}？`, '删除 API Key', {
    type: 'warning',
  });
  await deleteApiKeyApi(key.id);
  ElMessage.success('已删除');
  await load();
}

async function copyText(value: string, label = '内容') {
  if (!value) return;
  if (!(await copyToClipboard(value))) {
    ElMessage.error('复制失败，请手动复制');
    return;
  }
  ElMessage.success(`${label}已复制`);
}

onMounted(load);
</script>

<template>
  <div class="account-layout" v-loading="loading">
    <section class="page-stack">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>账户资料</strong>
            <el-button :icon="Refresh" @click="load">刷新</el-button>
          </div>
        </template>
        <div class="account-profile">
          <div class="account-avatar">
            <el-icon><User /></el-icon>
          </div>
          <el-form label-position="top" class="account-form">
            <el-form-item label="显示名称">
              <el-input v-model="profileForm.name" />
            </el-form-item>
            <el-form-item label="邮箱">
              <el-input v-model.trim="profileForm.email" />
            </el-form-item>
            <el-form-item label="角色">
              <el-tag>{{ auth.user?.role }}</el-tag>
            </el-form-item>
            <el-button type="primary" @click="saveProfile">保存资料</el-button>
          </el-form>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>安全设置</strong>
          </div>
        </template>
        <el-form label-position="top" class="security-form">
          <el-form-item label="当前密码">
            <el-input
              v-model="passwordForm.currentPassword"
              type="password"
              show-password
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>
          <el-form-item label="新密码">
            <el-input
              v-model="passwordForm.newPassword"
              type="password"
              show-password
            >
              <template #prefix>
                <el-icon><Key /></el-icon>
              </template>
            </el-input>
          </el-form-item>
          <el-button type="primary" plain @click="changePassword"
            >修改密码</el-button
          >
        </el-form>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>API Key</strong>
            <el-button
              type="primary"
              :icon="Plus"
              @click="dialogVisible = true"
            >
              新建
            </el-button>
          </div>
        </template>
        <el-alert
          v-if="createdKey"
          type="success"
          show-icon
          :closable="true"
          class="key-alert"
          @close="createdKey = ''"
        >
          <template #title>
            <div class="created-key">
              <span>{{ createdKey }}</span>
              <el-button
                size="small"
                :icon="CopyDocument"
                @click="copyText(createdKey, 'API Key')"
              >
                复制
              </el-button>
            </div>
          </template>
        </el-alert>

        <el-table :data="apiKeys" class="clean-table">
          <el-table-column label="名称" min-width="180">
            <template #default="{ row }">
              <div class="album-cell">
                <strong>{{ row.name }}</strong>
                <span>{{ row.id }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="180">
            <template #default="{ row }">{{
              formatDate(row.createdAt)
            }}</template>
          </el-table-column>
          <el-table-column label="最后使用" width="180">
            <template #default="{ row }">{{
              formatDate(row.lastUsedAt)
            }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }">
              <el-button
                type="danger"
                plain
                size="small"
                :icon="Delete"
                @click="removeKey(row)"
              />
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </section>

    <aside class="page-stack">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>容量</strong>
            <el-icon><Wallet /></el-icon>
          </div>
        </template>
        <div class="quota-panel">
          <el-progress type="dashboard" :percentage="usage" />
          <div>
            <strong>{{ formatBytes(auth.user?.usedBytes ?? 0) }}</strong>
            <span>总额度 {{ formatBytes(auth.user?.quotaBytes ?? 0) }}</span>
          </div>
        </div>
        <div class="variant-grid">
          <div>
            <strong>{{ formatBytes(auth.user?.usedBytes ?? 0) }}</strong>
            <span>已用</span>
          </div>
          <div>
            <strong>{{ formatBytes(availableBytes) }}</strong>
            <span>剩余</span>
          </div>
          <div>
            <strong>{{ usage }}%</strong>
            <span>使用率</span>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>接口示例</strong>
            <el-button
              size="small"
              :icon="CopyDocument"
              @click="copyText(apiExample, '接口示例')"
            />
          </div>
        </template>
        <el-input
          :model-value="apiExample"
          type="textarea"
          :rows="5"
          readonly
        />
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <div class="panel-head">
            <strong>登录信息</strong>
          </div>
        </template>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="用户 ID">{{
            auth.user?.publicId
          }}</el-descriptions-item>
          <el-descriptions-item label="账号邮箱">{{
            auth.user?.email
          }}</el-descriptions-item>
        </el-descriptions>
        <div class="form-actions account-session-actions">
          <el-button :icon="SwitchButton" @click="auth.logout()">
            退出登录
          </el-button>
        </div>
      </el-card>
    </aside>

    <el-dialog v-model="dialogVisible" title="新建 API Key" width="420">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="keyForm.name">
            <template #prefix>
              <el-icon><Key /></el-icon>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="createKey">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
