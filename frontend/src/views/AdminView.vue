<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { DataBoard, Key, Refresh, SetUp, User } from '@element-plus/icons-vue';
import {
  type AdminUser,
  type AuditLog,
  type MaintenanceSummary,
  listAuditLogsApi,
  listUsersApi,
  maintenanceSummaryApi,
  migrateImagesApi,
  recalculateUserUsageApi,
  reprocessImagesApi,
  resetUserPasswordApi,
  updateUserApi,
} from '@/api/admin';
import {
  getTelegramStatusApi,
  pollTelegramApi,
  testTelegramApi,
  type TelegramStatus,
} from '@/api/telegram';
import type { StorageProvider } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { formatBytes, formatDate } from '@/utils/format';

const auth = useAuthStore();
const activeTab = ref('users');
const loading = ref(false);
const users = ref<AdminUser[]>([]);
const totalUsers = ref(0);
const auditLogs = ref<AuditLog[]>([]);
const auditTotal = ref(0);
const maintenance = ref<MaintenanceSummary | null>(null);
const telegram = ref<TelegramStatus | null>(null);
const selectedUser = ref<AdminUser | null>(null);
const userDialogVisible = ref(false);
const passwordDialogVisible = ref(false);
const maintenanceLoading = ref(false);
const maintenanceAction = ref<'reprocess' | 'migrate' | ''>('');
const userQuery = reactive({
  page: 1,
  pageSize: 20,
  q: '',
  role: '' as '' | 'USER' | 'ADMIN',
  disabled: '' as '' | 'true' | 'false',
});
const userForm = reactive({
  email: '',
  name: '',
  role: 'USER' as 'USER' | 'ADMIN',
  disabled: false,
  quotaMb: 1024,
});
const passwordForm = reactive({
  password: '',
});
const maintenanceForm = reactive({
  targetProvider: 'S3' as StorageProvider,
  migrateLimit: 50,
  reprocessLimit: 100,
  missingOnly: true,
});
const auditQuery = reactive({
  page: 1,
  pageSize: 30,
  action: '',
  target: '',
});

const isAdmin = computed(() => auth.user?.role === 'ADMIN');
const providerCounts = computed(() => {
  const map = new Map<StorageProvider, number>();
  for (const item of maintenance.value?.byProvider ?? []) {
    map.set(item.provider, item.count);
  }
  return {
    S3: map.get('S3') ?? 0,
    LOCAL: map.get('LOCAL') ?? 0,
  };
});

async function loadUsers() {
  if (!isAdmin.value) return;
  loading.value = true;
  try {
    const data = await listUsersApi({
      page: userQuery.page,
      pageSize: userQuery.pageSize,
      q: userQuery.q || undefined,
      role: userQuery.role || undefined,
      disabled:
        userQuery.disabled === '' ? undefined : userQuery.disabled === 'true',
    });
    users.value = data.items;
    totalUsers.value = data.total;
  } finally {
    loading.value = false;
  }
}

async function loadMaintenance() {
  if (!isAdmin.value) return;
  maintenanceLoading.value = true;
  try {
    maintenance.value = await maintenanceSummaryApi();
  } finally {
    maintenanceLoading.value = false;
  }
}

async function loadAudit() {
  if (!isAdmin.value) return;
  const data = await listAuditLogsApi({
    page: auditQuery.page,
    pageSize: auditQuery.pageSize,
    action: auditQuery.action || undefined,
    target: auditQuery.target || undefined,
  });
  auditLogs.value = data.items;
  auditTotal.value = data.total;
}

async function loadTelegram() {
  telegram.value = await getTelegramStatusApi();
}

async function loadAll() {
  await Promise.all([
    loadUsers(),
    loadMaintenance(),
    loadAudit(),
    loadTelegram(),
  ]);
}

function openUser(row: AdminUser) {
  selectedUser.value = row;
  userForm.email = row.email;
  userForm.name = row.name;
  userForm.role = row.role;
  userForm.disabled = row.disabled;
  userForm.quotaMb = Math.max(1, Math.round(row.quotaBytes / 1024 / 1024));
  userDialogVisible.value = true;
}

async function saveUser() {
  if (!selectedUser.value) return;
  const updated = await updateUserApi(selectedUser.value.id, {
    email: userForm.email,
    name: userForm.name,
    role: userForm.role,
    disabled: userForm.disabled,
    quotaMb: userForm.quotaMb,
  });
  ElMessage.success('用户已更新');
  userDialogVisible.value = false;
  selectedUser.value = updated;
  if (auth.user?.id === updated.id) {
    await auth.loadProfile();
  }
  await loadUsers();
}

function openPassword(row: AdminUser) {
  selectedUser.value = row;
  passwordForm.password = '';
  passwordDialogVisible.value = true;
}

async function resetPassword() {
  if (!selectedUser.value) return;
  if (passwordForm.password.length < 8) {
    ElMessage.warning('密码至少 8 位');
    return;
  }
  await resetUserPasswordApi(selectedUser.value.id, passwordForm.password);
  ElMessage.success('密码已重置');
  passwordDialogVisible.value = false;
}

async function recalcUsage(row: AdminUser) {
  await recalculateUserUsageApi(row.id);
  ElMessage.success('容量已重新统计');
  await loadUsers();
}

async function reprocessMissing() {
  maintenanceAction.value = 'reprocess';
  try {
    const result = await reprocessImagesApi({
      limit: maintenanceForm.reprocessLimit,
      missingOnly: maintenanceForm.missingOnly,
    });
    if (result.affected) {
      ElMessage.success(`已提交 ${result.affected} 张图片处理任务`);
    } else {
      ElMessage.info('没有匹配的图片需要处理');
    }
    await loadMaintenance();
  } finally {
    maintenanceAction.value = '';
  }
}

async function migrateStorage() {
  maintenanceAction.value = 'migrate';
  try {
    await ElMessageBox.confirm(
      `确认迁移最多 ${maintenanceForm.migrateLimit} 张图片到 ${maintenanceForm.targetProvider}？`,
      '存储迁移',
      { type: 'warning' },
    );
    const result = await migrateImagesApi({
      targetProvider: maintenanceForm.targetProvider,
      limit: maintenanceForm.migrateLimit,
      reprocess: true,
    });
    if (result.affected || result.failed) {
      ElMessage.success(
        `已迁移 ${result.affected} 张，失败 ${result.failed} 张`,
      );
    } else {
      ElMessage.info('没有需要迁移的图片');
    }
    await loadMaintenance();
  } finally {
    maintenanceAction.value = '';
  }
}

async function pollTelegram() {
  telegram.value = await pollTelegramApi();
  ElMessage.success('已触发轮询');
}

async function testTelegram() {
  const result = await testTelegramApi();
  if (!result.ok) {
    ElMessage.warning(result.message || 'Bot 未配置');
    return;
  }
  ElMessage.success('Telegram Bot 配置可用');
}

onMounted(loadAll);
</script>

<template>
  <div v-if="!isAdmin" class="page-stack">
    <el-alert
      title="当前账户不是管理员，无法访问管理中心"
      type="warning"
      :closable="false"
    />
  </div>

  <div v-else class="page-stack" v-loading="loading">
    <section class="metrics-grid">
      <el-card shadow="never" class="metric-card">
        <div class="metric-icon">
          <el-icon><User /></el-icon>
        </div>
        <div>
          <span>用户</span>
          <strong>{{ totalUsers }}</strong>
        </div>
      </el-card>
      <el-card shadow="never" class="metric-card">
        <div class="metric-icon">
          <el-icon><DataBoard /></el-icon>
        </div>
        <div>
          <span>S3 / 本机</span>
          <strong>{{ providerCounts.S3 }} / {{ providerCounts.LOCAL }}</strong>
        </div>
      </el-card>
      <el-card shadow="never" class="metric-card">
        <div class="metric-icon">
          <el-icon><SetUp /></el-icon>
        </div>
        <div>
          <span>待修复派生图</span>
          <strong>{{ maintenance?.missingDerived ?? 0 }}</strong>
        </div>
      </el-card>
      <el-card shadow="never" class="metric-card">
        <div class="metric-icon">
          <el-icon><Key /></el-icon>
        </div>
        <div>
          <span>Bot 启用账户</span>
          <strong>{{ telegram?.enabledAccounts ?? 0 }}</strong>
        </div>
      </el-card>
    </section>

    <el-card shadow="never" class="panel-card">
      <template #header>
        <div class="panel-head">
          <strong>管理中心</strong>
          <el-button :icon="Refresh" @click="loadAll">刷新</el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="用户管理" name="users">
          <div class="toolbar">
            <el-input
              v-model="userQuery.q"
              class="toolbar-search"
              placeholder="搜索邮箱或名称"
              clearable
              @keyup.enter="loadUsers"
            />
            <el-select
              v-model="userQuery.role"
              class="toolbar-select"
              placeholder="角色"
              clearable
              @change="loadUsers"
            >
              <el-option label="管理员" value="ADMIN" />
              <el-option label="普通用户" value="USER" />
            </el-select>
            <el-select
              v-model="userQuery.disabled"
              class="toolbar-select"
              placeholder="状态"
              clearable
              @change="loadUsers"
            >
              <el-option label="启用" value="false" />
              <el-option label="禁用" value="true" />
            </el-select>
            <el-button @click="loadUsers">查询</el-button>
          </div>

          <el-table :data="users" class="clean-table admin-table">
            <el-table-column label="用户" min-width="240">
              <template #default="{ row }">
                <div class="admin-user-cell">
                  <strong>{{ row.name }} · {{ row.publicId }}</strong>
                  <span>{{ row.email }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="角色" width="110">
              <template #default="{ row }">
                <el-tag :type="row.role === 'ADMIN' ? 'success' : 'info'">{{
                  row.role
                }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.disabled ? 'danger' : 'success'">
                  {{ row.disabled ? '禁用' : '启用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="容量" min-width="180">
              <template #default="{ row }">
                {{ formatBytes(row.usedBytes) }} /
                {{ formatBytes(row.quotaBytes) }}
              </template>
            </el-table-column>
            <el-table-column label="图片/相册/API" width="150">
              <template #default="{ row }">
                {{ row.imageCount }} / {{ row.albumCount }} /
                {{ row.apiKeyCount }}
              </template>
            </el-table-column>
            <el-table-column label="最近登录" width="170">
              <template #default="{ row }">{{
                row.lastLoginAt ? formatDate(row.lastLoginAt) : '-'
              }}</template>
            </el-table-column>
            <el-table-column label="操作" width="260" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="openUser(row)">编辑</el-button>
                <el-button size="small" @click="openPassword(row)"
                  >重置密码</el-button
                >
                <el-button size="small" @click="recalcUsage(row)"
                  >重算容量</el-button
                >
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="userQuery.page"
            v-model:page-size="userQuery.pageSize"
            layout="total, sizes, prev, pager, next"
            :page-sizes="[10, 20, 50, 100]"
            :total="totalUsers"
            @change="loadUsers"
          />
        </el-tab-pane>

        <el-tab-pane
          label="维护工具"
          name="maintenance"
          v-loading="maintenanceLoading"
        >
          <div class="settings-grid wide">
            <el-card shadow="never" class="panel-card">
              <template #header><strong>派生图修复</strong></template>
              <el-form label-position="top">
                <el-form-item label="处理数量">
                  <el-input-number
                    v-model="maintenanceForm.reprocessLimit"
                    :min="1"
                    :max="1000"
                  />
                </el-form-item>
                <el-form-item label="范围">
                  <el-switch
                    v-model="maintenanceForm.missingOnly"
                    active-text="只处理缺失缩略图/WebP"
                  />
                </el-form-item>
                <el-button
                  type="primary"
                  :loading="maintenanceAction === 'reprocess'"
                  @click="reprocessMissing"
                  >提交处理任务</el-button
                >
              </el-form>
            </el-card>

            <el-card shadow="never" class="panel-card">
              <template #header><strong>存储迁移</strong></template>
              <el-form label-position="top">
                <el-form-item label="目标存储">
                  <el-segmented
                    v-model="maintenanceForm.targetProvider"
                    :options="[
                      { label: '第三方对象存储', value: 'S3' },
                      { label: '本机存储', value: 'LOCAL' },
                    ]"
                  />
                </el-form-item>
                <el-form-item label="迁移数量">
                  <el-input-number
                    v-model="maintenanceForm.migrateLimit"
                    :min="1"
                    :max="500"
                  />
                </el-form-item>
                <el-button
                  type="primary"
                  :loading="maintenanceAction === 'migrate'"
                  @click="migrateStorage"
                  >开始迁移</el-button
                >
              </el-form>
            </el-card>
          </div>
        </el-tab-pane>

        <el-tab-pane label="审计日志" name="audit">
          <div class="toolbar">
            <el-input
              v-model="auditQuery.action"
              class="toolbar-search"
              placeholder="动作，例如 user.update"
              clearable
            />
            <el-input
              v-model="auditQuery.target"
              class="toolbar-select"
              placeholder="目标，例如 user"
              clearable
            />
            <el-button @click="loadAudit">查询</el-button>
          </div>
          <el-table :data="auditLogs" class="clean-table">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{
                formatDate(row.createdAt)
              }}</template>
            </el-table-column>
            <el-table-column label="动作" width="190" prop="action" />
            <el-table-column label="操作者" min-width="220">
              <template #default="{ row }">
                {{ row.actor ? `${row.actor.name} / ${row.actor.email}` : '-' }}
              </template>
            </el-table-column>
            <el-table-column label="目标" width="160">
              <template #default="{ row }">{{ row.target || '-' }}</template>
            </el-table-column>
            <el-table-column label="IP" width="150" prop="ip" />
            <el-table-column label="详情" min-width="260">
              <template #default="{ row }">
                <code>{{
                  row.metadata ? JSON.stringify(row.metadata) : '-'
                }}</code>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="auditQuery.page"
            v-model:page-size="auditQuery.pageSize"
            layout="total, sizes, prev, pager, next"
            :page-sizes="[20, 30, 50, 100]"
            :total="auditTotal"
            @change="loadAudit"
          />
        </el-tab-pane>

        <el-tab-pane label="Telegram" name="telegram">
          <div class="page-stack">
            <div class="toolbar">
              <el-button type="primary" @click="testTelegram"
                >测试 Bot</el-button
              >
              <el-button @click="pollTelegram">立即轮询</el-button>
              <el-button @click="loadTelegram">刷新</el-button>
            </div>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="启用账户">{{
                telegram?.enabledAccounts ?? 0
              }}</el-descriptions-item>
              <el-descriptions-item label="轮询中">{{
                telegram?.running ? '是' : '否'
              }}</el-descriptions-item>
              <el-descriptions-item label="最近轮询">{{
                telegram?.lastPollAt ? formatDate(telegram.lastPollAt) : '-'
              }}</el-descriptions-item>
              <el-descriptions-item label="最近错误">{{
                telegram?.lastError || '-'
              }}</el-descriptions-item>
            </el-descriptions>
            <el-table :data="telegram?.accounts ?? []" class="clean-table">
              <el-table-column
                label="用户 ID"
                prop="ownerPublicId"
                min-width="120"
              />
              <el-table-column label="启用" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.enabled ? 'success' : 'info'">{{
                    row.enabled ? '是' : '否'
                  }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="Token" width="100">
                <template #default="{ row }">{{
                  row.configured ? '已配置' : '未配置'
                }}</template>
              </el-table-column>
              <el-table-column label="允许 Chat" min-width="220">
                <template #default="{ row }">{{
                  row.allowedChatIds.join(', ') || '不限'
                }}</template>
              </el-table-column>
              <el-table-column
                label="Last Update"
                width="140"
                prop="lastUpdateId"
              />
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="userDialogVisible" title="编辑用户" width="520px">
      <el-form label-position="top">
        <el-form-item label="邮箱">
          <el-input v-model="userForm.email" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="userForm.name" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userForm.role" class="full-width">
            <el-option label="管理员" value="ADMIN" />
            <el-option label="普通用户" value="USER" />
          </el-select>
        </el-form-item>
        <el-form-item label="账户总容量 MB">
          <el-input-number
            v-model="userForm.quotaMb"
            :min="1"
            :max="1024 * 1024"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="userForm.disabled" active-text="禁用账户" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="passwordDialogVisible" title="重置密码" width="420px">
      <el-form label-position="top">
        <el-form-item label="新密码">
          <el-input
            v-model="passwordForm.password"
            type="password"
            show-password
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="resetPassword">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>
