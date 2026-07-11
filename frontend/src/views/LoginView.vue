<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus/es/components/message/index';
import { Key, Lock, Message } from '@element-plus/icons-vue';
import {
  registrationStatusApi,
  requestRegistrationCodeApi,
  requestPasswordResetApi,
  resetPasswordApi,
} from '@/api/auth';
import { useAuthStore } from '@/stores/auth';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const formRef = ref<FormInstance>();
const loading = ref(false);
const sendingCode = ref(false);
const codeCooldown = ref(0);
let codeTimer: number | undefined;
const mode = ref<AuthMode>('login');
const allowRegister = ref(false);
const firstUser = ref(false);
const form = reactive({
  email: '',
  password: '',
  verificationCode: '',
  newPassword: '',
});

const productName = 'PicVault';
const title = computed(() => {
  if (mode.value === 'register') return '创建账户';
  if (mode.value === 'forgot') return '找回密码';
  if (mode.value === 'reset') return '设置新密码';
  return '登录 PicVault';
});
const subtitle = computed(() => {
  if (mode.value === 'register') return '创建团队的图片资产空间';
  if (mode.value === 'forgot') return '输入账户邮箱，系统会发送密码重置邮件';
  if (mode.value === 'reset') return '设置一个新的安全密码';
  return allowRegister.value
    ? '进入你的图片资产工作台'
    : '使用管理员账户进入工作台';
});
const submitLabel = computed(() => {
  if (mode.value === 'register') return '注册并登录';
  if (mode.value === 'forgot') return '发送重置邮件';
  if (mode.value === 'reset') return '确认重置密码';
  return '登录';
});
const passwordAutocomplete = computed(() =>
  mode.value === 'register' ? 'new-password' : 'current-password',
);
const needsPassword = computed(() =>
  ['login', 'register'].includes(mode.value),
);
const showFirstAdminHint = computed(
  () => allowRegister.value && firstUser.value && mode.value === 'register',
);
const rules = computed<FormRules>(() => ({
  email: [
    {
      required: mode.value !== 'reset',
      message: '请输入邮箱',
      trigger: 'blur',
    },
    { type: 'email', message: '邮箱格式不正确', trigger: ['blur', 'change'] },
  ],
  verificationCode: [
    {
      required: mode.value === 'register',
      message: '请输入邮箱验证码',
      trigger: 'blur',
    },
    { len: 6, message: '验证码为 6 位', trigger: ['blur', 'change'] },
  ],
  password: [
    {
      required: needsPassword.value,
      message: '请输入密码',
      trigger: 'blur',
    },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' },
  ],
  newPassword: [
    {
      required: mode.value === 'reset',
      message: '请输入新密码',
      trigger: 'blur',
    },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' },
  ],
}));

onMounted(() => {
  if (
    route.name === 'reset-password' &&
    typeof route.query.token === 'string'
  ) {
    mode.value = 'reset';
  }

  void loadRegistrationStatus();
});

onUnmounted(() => {
  if (codeTimer) window.clearInterval(codeTimer);
});

async function loadRegistrationStatus() {
  try {
    const status = await registrationStatusApi();
    firstUser.value = status.firstUser;
    allowRegister.value = status.registrationEnabled;
  } catch {
    firstUser.value = false;
    allowRegister.value = false;
  }
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login({ email: form.email, password: form.password });
      ElMessage.success('已进入控制台');
      router.push('/dashboard');
      return;
    }

    if (mode.value === 'register') {
      await auth.register({
        email: form.email,
        password: form.password,
        verificationCode: form.verificationCode,
      });
      ElMessage.success('已进入控制台');
      router.push('/dashboard');
      return;
    }

    if (mode.value === 'forgot') {
      await requestPasswordResetApi({ email: form.email });
      ElMessage.success('如果邮箱存在，重置邮件会发送到该邮箱');
      setMode('login');
      return;
    }

    const token = route.query.token;
    if (typeof token !== 'string' || !token) {
      ElMessage.error('重置链接无效');
      return;
    }

    await resetPasswordApi({
      token,
      newPassword: form.newPassword,
    });
    ElMessage.success('密码已重置，请重新登录');
    router.replace('/login');
    setMode('login');
  } finally {
    loading.value = false;
  }
}

async function sendRegistrationCode() {
  if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    ElMessage.warning('请先输入正确的邮箱');
    return;
  }

  sendingCode.value = true;
  try {
    await requestRegistrationCodeApi({ email: form.email });
    ElMessage.success('验证码已发送');
    startCodeCooldown();
  } finally {
    sendingCode.value = false;
  }
}

function startCodeCooldown() {
  codeCooldown.value = 60;
  if (codeTimer) window.clearInterval(codeTimer);
  codeTimer = window.setInterval(() => {
    codeCooldown.value -= 1;
    if (codeCooldown.value <= 0 && codeTimer) {
      window.clearInterval(codeTimer);
      codeTimer = undefined;
    }
  }, 1000);
}

function setMode(nextMode: AuthMode) {
  mode.value = nextMode;
  form.password = '';
  form.verificationCode = '';
  form.newPassword = '';
  formRef.value?.clearValidate();

  if (nextMode !== 'reset' && route.name === 'reset-password') {
    router.replace('/login');
  }
}

function switchRegister() {
  setMode(mode.value === 'register' ? 'login' : 'register');
}
</script>

<template>
  <main class="login-page">
    <section class="login-visual">
      <div class="login-panel-brand login-image-brand">
        <div class="brand-mark">
          <img src="/picvault-mark.svg" alt="" />
        </div>
        <div>
          <strong>{{ productName }}</strong>
          <span>图片资产平台</span>
        </div>
      </div>

      <div class="login-copy">
        <span>你的图片工作空间</span>
        <h1>存得安心，找得轻松。</h1>
        <p>从上传到分享，让图片资产始终清楚、有序、随时可用。</p>
      </div>

      <div class="login-benefits">
        <span><b>01</b> 原图安全托管</span>
        <span><b>02</b> 多格式链接</span>
        <span><b>03</b> 相册与权限</span>
      </div>
    </section>

    <section class="login-panel">
      <el-card class="login-card" shadow="never">
        <div class="login-card-head">
          <h2>{{ title }}</h2>
          <p>{{ subtitle }}</p>
        </div>

        <div v-if="showFirstAdminHint" class="first-admin-hint">
          首次安装时，第一个注册成功的账户会自动成为管理员。
        </div>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          @submit.prevent="submit"
        >
          <el-form-item v-if="mode !== 'reset'" label="邮箱" prop="email">
            <el-input
              v-model.trim="form.email"
              size="large"
              autocomplete="username"
            >
              <template #prefix>
                <el-icon><Message /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item v-if="needsPassword" prop="password">
            <template #label>
              <div class="password-label-row">
                <span>密码</span>
                <button
                  v-if="mode === 'login'"
                  class="link-button compact"
                  type="button"
                  @click="setMode('forgot')"
                >
                  忘记密码？
                </button>
              </div>
            </template>
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              :autocomplete="passwordAutocomplete"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item
            v-if="mode === 'register'"
            label="邮箱验证码"
            prop="verificationCode"
          >
            <el-input
              v-model.trim="form.verificationCode"
              size="large"
              autocomplete="one-time-code"
              maxlength="6"
            >
              <template #prefix>
                <el-icon><Key /></el-icon>
              </template>
              <template #append>
                <el-button
                  :loading="sendingCode"
                  :disabled="codeCooldown > 0"
                  @click="sendRegistrationCode"
                >
                  {{ codeCooldown > 0 ? `${codeCooldown}s` : '发送验证码' }}
                </el-button>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item
            v-if="mode === 'reset'"
            label="新密码"
            prop="newPassword"
          >
            <el-input
              v-model="form.newPassword"
              size="large"
              type="password"
              show-password
              autocomplete="new-password"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-button
            native-type="submit"
            type="primary"
            size="large"
            class="full-button"
            :loading="loading"
          >
            {{ submitLabel }}
          </el-button>
        </el-form>

        <button
          v-if="allowRegister && mode !== 'forgot' && mode !== 'reset'"
          class="link-button"
          type="button"
          @click="switchRegister"
        >
          {{ mode === 'login' ? '没有账户？创建一个' : '已有账户？去登录' }}
        </button>

        <button
          v-if="mode === 'forgot' || mode === 'reset'"
          class="link-button"
          type="button"
          @click="setMode('login')"
        >
          返回登录
        </button>

        <p class="login-footnote">
          © {{ new Date().getFullYear() }} {{ productName }}
        </p>
      </el-card>
    </section>
  </main>
</template>
