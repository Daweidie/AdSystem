<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const router = useRouter();
const loading = ref(false);
const form = reactive({ phone: '', password: '' });

async function login() {
  if (!form.phone || !form.password) {
    ElMessage.warning('请输入手机号和密码');
    return;
  }
  loading.value = true;
  try {
    const response = await fetch(`${API}/management/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message || '登录失败');
    localStorage.setItem('demo18_token', payload.data.token);
    localStorage.setItem('demo18_user', JSON.stringify(payload.data.user));
    await router.push('/admin');
  } catch (error) {
    ElMessage.error(error.message || '登录失败');
  } finally {
    loading.value = false;
  }
}

</script>

<template>
  <div class="login-page">
    <section class="login-brand">
      <span class="brand-eyebrow">VIDEO ASSET PLATFORM</span>
      <h1>产品素材资源<br />管理系统</h1>
      <p>统一管理视频素材、推广链接与微信投放数据</p>
      <div class="brand-features">
        <span>视频点播</span><span>微信卡片</span><span>权限分级</span><span>投放统计</span>
      </div>
    </section>

    <section class="login-panel">
      <div class="login-card">
        <div class="login-mark">▶</div>
        <h2>欢迎登录</h2>
        <p class="login-subtitle">请使用分配给您的管理账号</p>
        <el-form @submit.prevent="login">
          <el-input v-model="form.phone" size="large" placeholder="请输入登录手机号" clearable>
            <template #prefix>⌕</template>
          </el-input>
          <el-input v-model="form.password" size="large" type="password" show-password placeholder="请输入登录密码" @keyup.enter="login">
            <template #prefix>◇</template>
          </el-input>
          <el-button class="login-button" type="primary" size="large" :loading="loading" @click="login">登录系统</el-button>
        </el-form>
      </div>
    </section>
  </div>
</template>
