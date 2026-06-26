<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus/es/components/message/index';
import { Grid, Key, Lock, Message, User } from '@element-plus/icons-vue';
import { requestPasswordResetApi, resetPasswordApi } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const formRef = ref<FormInstance>();
const loading = ref(false);
const mode = ref<AuthMode>('login');
const allowRegister = import.meta.env.VITE_ALLOW_REGISTER === 'true';
const form = reactive({
  email: '',
  name: '',
  password: '',
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
  return allowRegister ? '进入你的图片资产工作台' : '使用管理员账户进入工作台';
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
const rules = computed<FormRules>(() => ({
  email: [
    {
      required: mode.value !== 'reset',
      message: '请输入邮箱',
      trigger: 'blur',
    },
    { type: 'email', message: '邮箱格式不正确', trigger: ['blur', 'change'] },
  ],
  name: [
    {
      required: mode.value === 'register',
      message: '请输入名称',
      trigger: 'blur',
    },
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
});

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
        name: form.name,
        password: form.password,
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

function setMode(nextMode: AuthMode) {
  mode.value = nextMode;
  form.password = '';
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
      <div class="login-brand-line">
        <div class="brand-mark">
          <el-icon><Grid /></el-icon>
        </div>
        <div>
          <strong>{{ productName }}</strong>
          <span>Image Hosting Suite</span>
        </div>
      </div>

      <div class="login-copy">
        <span>Commercial Image Hosting</span>
        <h1>面向团队的图片托管与资产管理平台</h1>
        <p>集中管理上传、相册、外链、权限、存储与自动化处理流程。</p>
      </div>

      <div class="login-benefits">
        <span>Secure Uploads</span>
        <span>Storage Routing</span>
        <span>Team Operations</span>
      </div>
    </section>

    <section class="login-panel">
      <el-card class="login-card" shadow="never">
        <div class="login-lock">
          <el-icon><Key /></el-icon>
        </div>
        <div class="login-card-head">
          <h2>{{ title }}</h2>
          <p>{{ subtitle }}</p>
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
              placeholder="name@example.com"
              autocomplete="username"
            >
              <template #prefix>
                <el-icon><Message /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item v-if="mode === 'register'" label="名称" prop="name">
            <el-input
              v-model.trim="form.name"
              size="large"
              placeholder="Admin"
              autocomplete="name"
            >
              <template #prefix>
                <el-icon><User /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item v-if="needsPassword" label="密码" prop="password">
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              placeholder="至少 8 位"
              :autocomplete="passwordAutocomplete"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
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
              placeholder="至少 8 位"
              autocomplete="new-password"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <div v-if="mode === 'login'" class="login-minor-actions">
            <button
              class="link-button compact"
              type="button"
              @click="setMode('forgot')"
            >
              忘记密码？
            </button>
          </div>

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
