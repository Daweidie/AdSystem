<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import QRCode from 'qrcode';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const VOD_SDK = 'https://cdn-go.cn/cdn/vod-js-sdk-v6/latest/vod-js-sdk-v6.js';
const MAX_VIDEO_UPLOAD_SIZE_BYTES = 800 * 1024 * 1024;
// 暂时隐藏有问题的纯文字卡片实验入口，保留后端和历史链接兼容能力。
const TEXT_DESCRIPTION_EXPERIMENT_ENABLED = false;
const router = useRouter();
const user = ref(JSON.parse(localStorage.getItem('demo18_user') || 'null'));
const activePage = ref('dashboard');
const loading = ref(false);
const dashboardData = ref(null);
const materials = ref([]);
const businessGroups = ref([]);
const materialGroups = ref([]);
const users = ref([]);
const expiring = ref([]);
const domains = ref([]);
const cardDomainConfig = ref(null);
const myVisitQuota = ref(null);
const myVisitQuotaLoading = ref(false);
const suolinkSaving = ref(false);
const readinessLoading = ref(false);
const readiness = ref(null);
const visitQuotaData = ref({ period: '', perEmployee: 2000, groups: [] });
const visitQuotaPerEmployee = ref(2000);
const visitQuotaAdditions = reactive({});
const visitQuotaBases = reactive({});
const visitQuotaEditVisible = ref(false);
const visitQuotaEditGroup = ref(null);
const suolinkSharedDomains = ['iq1k.cn', 'm6z.cn', 'i6q.cn'];
const suolinkForm = reactive({ enabled: false, apiKey: '', apiKeyConfigured: false, apiKeyMasked: '', domain: '' });
const domainEditVisible = ref(false);
const domainForm = reactive({ id: '', domain: '', remark: '', isEnabled: true, isPrimary: false });
const expandedMaterials = ref(new Set());
const selectedRows = ref([]);

const materialFilter = reactive({ keyword: '', businessGroupId: '', materialGroupId: '' });
const userFilter = reactive({ role: '' });
const materialGroupBusinessId = ref('');
const uploadProgress = ref(0);
const uploading = ref(false);
const uploadForm = reactive({
  businessGroupId: '', materialGroupId: '', title: '', description: '', expires: [],
  videoFile: null, coverFile: null,
});
const userForm = reactive({ name: '', phone: '', password: '', role: 'general_user', businessGroupId: '', expiresAt: '' });
const groupForm = reactive({ name: '', managerName: '', managerPhone: '', password: '', expiresAt: '' });
const userEditVisible = ref(false);
const groupEditVisible = ref(false);
const materialEditVisible = ref(false);
const shareCardVisible = ref(false);
const shareCardSaving = ref(false);
const abResultVisible = ref(false);
const abResult = reactive({ standard: '', textDescription: '' });
const cardModeSelections = reactive({});
const wechatShareVisible = ref(false);
const wechatShareLoading = ref(false);
const editUserForm = reactive({ id: '', name: '', phone: '', password: '', role: '', businessGroupId: '', expiresAt: '', status: 'active' });
const editGroupForm = reactive({ id: '', name: '', managerName: '', managerPhone: '', password: '', expiresAt: '', status: 'active' });
const editMaterialForm = reactive({ id: '', title: '', description: '', businessGroupId: '', materialGroupId: '' });
const shareCardForm = reactive({ materialId: '', linkId: '', link: '', title: '', description: '', coverUrl: '', coverFile: null, wechatCardMode: 'standard' });
const wechatShareForm = reactive({ platform: '', title: '', coverUrl: '', link: '', qrDataUrl: '', wechatCardMode: 'standard' });

const roleLabels = {
  super_admin: '超级管理员', system_admin: '系统管理员',
  business_manager: '业务组管理员', general_user: '一般用户',
};
const statusLabels = { ready: '正常', disabled: '暂停使用', expired: '已过期', deleted: '已删除', active: '正常' };
const isPlatformAdmin = computed(() => ['super_admin', 'system_admin'].includes(user.value?.role));
const canManageMaterials = computed(() => true);
const canManageMaterialAdmin = computed(() => user.value?.role !== 'general_user');
const canViewVisitQuota = computed(() =>
  ['business_manager', 'general_user'].includes(user.value?.role)
  && Boolean(user.value?.businessGroupId),
);
const canManagePromoters = computed(() => isPlatformAdmin.value);
const canManageBusinessGroups = computed(() => isPlatformAdmin.value);
const isSuper = computed(() => user.value?.role === 'super_admin');

const menus = computed(() => {
  const sections = [
    {
      title: '素材资源管理', icon: '☆',
      items: [
        { key: 'materials', label: '我的素材列表' },
        ...(canManageMaterialAdmin.value ? [{ key: 'material-groups', label: '素材组管理' }, { key: 'upload', label: '上传素材' }] : []),
      ],
    },
    {
      title: '推广员管理', icon: '☆',
      items: [
        { key: 'promoters', label: '推广员列表' },
        ...(canManageBusinessGroups.value ? [{ key: 'business-groups', label: '业务组列表' }] : []),
        ...(canManagePromoters.value ? [{ key: 'add-promoter', label: '添加推广员' }] : []),
        { key: 'expiring', label: '到期提醒（15天内）' },
      ],
    },
  ];
  if (isSuper.value) {
    sections.push({
      title: '系统管理员', icon: '☆',
      items: [{ key: 'admins', label: '管理员列表' }, { key: 'add-admin', label: '添加管理员账号' }],
    });
  }
  if (isSuper.value) {
    sections.push({
      title: '系统设置', icon: '☆',
      items: [
        { key: 'customer-link', label: '域名池管理' },
        { key: 'visit-quotas', label: '访问量管理' },
      ],
    });
  }
  return sections;
});

const pageTitle = computed(() => {
  const labels = {
    dashboard: '运营总览', materials: '我的素材列表', 'material-groups': '素材组管理', upload: '上传素材',
    promoters: '推广员列表', 'business-groups': '业务组列表', 'add-promoter': '添加推广员',
    expiring: '到期提醒（15天内）', admins: '管理员列表', 'add-admin': '添加管理员账号',
    'add-business-group': '添加业务组',
    'customer-link': '域名池管理',
    'visit-quotas': '访问量管理',
  };
  return labels[activePage.value] || '管理后台';
});

const resultCount = computed(() => {
  if (activePage.value === 'materials') return materials.value.length;
  if (activePage.value === 'material-groups') return materialGroups.value.length;
  if (activePage.value === 'business-groups') return businessGroups.value.length;
  if (activePage.value === 'expiring') return expiring.value.length;
  if (activePage.value === 'customer-link') return domains.value.length;
  if (activePage.value === 'visit-quotas') return visitQuotaData.value.groups.length;
  if (['promoters', 'admins'].includes(activePage.value)) return users.value.length;
  return null;
});

async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${localStorage.getItem('demo18_token') || ''}`,
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    logout();
    throw new Error('登录已失效');
  }
  if (!response.ok || payload.success === false) throw new Error(payload.message || `请求失败（${response.status}）`);
  return payload.data;
}

function logout() {
  localStorage.removeItem('demo18_token');
  localStorage.removeItem('demo18_user');
  router.replace('/');
}

function formatDate(value) {
  if (!value) return '长期有效';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', hour12: false, timeZone: 'Asia/Shanghai',
  }).format(date);
}

function formatFormDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const part = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function daysRemaining(value) {
  return value ? Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000)) : '长期';
}

async function selectPage(key) {
  if (key === 'visit-quotas' && !isSuper.value) {
    ElMessage.error('只有超级管理员可以管理访问量');
    return;
  }
  activePage.value = key;
  loading.value = true;
  try {
    if (key === 'dashboard') await loadDashboard();
    if (key === 'materials') {
      await loadMaterials();
      if (canViewVisitQuota.value) await loadMyVisitQuota();
    }
    if (key === 'material-groups') await loadMaterialGroups();
    if (key === 'upload') await Promise.all([loadBusinessGroups(), loadMaterialGroups()]);
    if (key === 'business-groups') await loadBusinessGroups();
    if (key === 'promoters') { userFilter.role = ''; await loadUsers('promoters'); }
    if (key === 'admins') await loadUsers('admins');
    if (key === 'add-promoter' || key === 'add-admin') await loadBusinessGroups();
    if (key === 'expiring') expiring.value = await request('/management/expiring-users');
    if (key === 'customer-link') await loadDomainPool();
    if (key === 'visit-quotas') await loadVisitQuotas();
  } catch (error) {
    ElMessage.error(error.message);
  } finally { loading.value = false; }
}

async function loadDashboard() { dashboardData.value = await request('/management/dashboard'); }
async function loadBusinessGroups() {
  businessGroups.value = await request('/management/business-groups');
  if (!uploadForm.businessGroupId && businessGroups.value[0]) uploadForm.businessGroupId = String(businessGroups.value[0].id);
  if (!userForm.businessGroupId && businessGroups.value[0]) userForm.businessGroupId = String(businessGroups.value[0].id);
}
async function loadMaterialGroups() {
  const query = materialGroupBusinessId.value ? `?businessGroupId=${materialGroupBusinessId.value}` : '';
  materialGroups.value = await request(`/management/material-groups${query}`);
}
async function loadMaterials() {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(materialFilter)) if (value) query.set(key, value);
  const data = await request(`/management/materials?${query}`);
  materials.value = data.map((material) => ({
    ...material,
    cover_url: resolveAssetUrl(material.cover_url),
  }));
  for (const material of materials.value) {
    const key = String(material.id);
    if (!cardModeSelections[key]) cardModeSelections[key] = 'standard';
  }
}

async function loadMyVisitQuota() {
  if (!canViewVisitQuota.value) return;
  myVisitQuotaLoading.value = true;
  try {
    myVisitQuota.value = await request('/management/visit-quota');
  } catch (error) {
    myVisitQuota.value = null;
    ElMessage.error(error.message);
  } finally {
    myVisitQuotaLoading.value = false;
  }
}
async function loadUsers(kind = activePage.value) {
  const data = await request(kind === 'admins' ? '/management/users' : '/management/users?role=general_user');
  users.value = data.filter((item) => kind === 'admins'
    ? ['super_admin', 'system_admin'].includes(item.role)
    : item.role === 'general_user');
}

async function loadVisitQuotas() {
  const data = await request('/management/visit-quotas');
  visitQuotaData.value = {
    period: data.period || '',
    perEmployee: Number(data.perEmployee || 0),
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
  visitQuotaPerEmployee.value = visitQuotaData.value.perEmployee;
  for (const group of visitQuotaData.value.groups) {
    const key = String(group.businessGroupId);
    if (visitQuotaAdditions[key] === undefined) visitQuotaAdditions[key] = '';
    visitQuotaBases[key] = Number(group.baseQuota || 0);
  }
}

function openVisitQuotaEditor(group) {
  const key = String(group.businessGroupId);
  visitQuotaBases[key] = Number(group.baseQuota || 0);
  visitQuotaAdditions[key] = '';
  visitQuotaEditGroup.value = group;
  visitQuotaEditVisible.value = true;
}

async function saveVisitQuotaPerEmployee() {
  const value = Number(visitQuotaPerEmployee.value);
  if (!Number.isInteger(value) || value < 1 || value > 1000000) {
    ElMessage.warning('每人额度必须是 1 到 1000000 之间的整数');
    return;
  }
  try {
    await request('/management/visit-quotas/per-employee', {
      method: 'PUT',
      body: JSON.stringify({ perEmployee: value }),
    });
    ElMessage.success('每人月度额度已保存，将从下个自然月生效');
    await loadVisitQuotas();
  } catch (error) { ElMessage.error(error.message); }
}

async function addVisitQuota(group) {
  const key = String(group.businessGroupId);
  const amount = Number(visitQuotaAdditions[key]);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000000) {
    ElMessage.warning('追加额度必须是 1 到 100000000 之间的整数');
    return;
  }
  try {
    await request('/management/visit-quotas/add', {
      method: 'POST',
      body: JSON.stringify({ businessGroupId: group.businessGroupId, additionalQuota: amount }),
    });
    visitQuotaAdditions[key] = '';
    ElMessage.success(`已为“${group.businessGroupName}”追加 ${amount} 次访问额度`);
    await loadVisitQuotas();
  } catch (error) { ElMessage.error(error.message); }
}
async function updateVisitQuotaBase(group) {
  const key = String(group.businessGroupId);
  const baseQuota = Number(visitQuotaBases[key]);
  if (!Number.isInteger(baseQuota) || baseQuota < 1 || baseQuota > 100000000) {
    ElMessage.warning('当前月基础额度必须是 1 到 100000000 之间的整数');
    return;
  }
  try {
    await request('/management/visit-quotas/base', {
      method: 'PUT',
      body: JSON.stringify({ businessGroupId: group.businessGroupId, baseQuota }),
    });
    ElMessage.success(`“${group.businessGroupName}”本月基础额度已立即更新为 ${baseQuota} 次`);
    await loadVisitQuotas();
  } catch (error) { ElMessage.error(error.message); }
}

async function loadDomainPool() {
  const [domainList, suolinkConfig, cardConfig] = await Promise.all([
    request('/domain/list'), request('/domain/suolink-config'), request('/domain/card-domain-config'),
  ]);
  domains.value = domainList;
  cardDomainConfig.value = cardConfig;
  Object.assign(suolinkForm, {
    enabled: Boolean(suolinkConfig.enabled),
    apiKey: '',
    apiKeyConfigured: Boolean(suolinkConfig.apiKeyConfigured),
    apiKeyMasked: suolinkConfig.apiKeyMasked || '',
    domain: suolinkConfig.domain || '',
  });
  readiness.value = null;
}

async function saveSuolinkConfig() {
  if (suolinkForm.enabled && !suolinkForm.apiKey.trim() && !suolinkForm.apiKeyConfigured) {
    ElMessage.warning('启用 Suolink 前请填写 API Key');
    return;
  }
  if (suolinkForm.enabled && !suolinkForm.domain.trim()) {
    ElMessage.warning('启用 Suolink 前请填写独享域名');
    return;
  }
  suolinkSaving.value = true;
  try {
    const result = await request('/domain/suolink-config', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: suolinkForm.enabled,
        domain: suolinkForm.domain,
        ...(suolinkForm.apiKey.trim() ? { apiKey: suolinkForm.apiKey } : {}),
      }),
    });
    ElMessage.success(result.enabled ? 'Suolink 兼容配置已启用' : 'Suolink 兼容配置已停用');
    await loadDomainPool();
  } catch (error) { ElMessage.error(error.message); }
  finally { suolinkSaving.value = false; }
}

async function checkDeliveryReadiness() {
  readinessLoading.value = true;
  try {
    readiness.value = await request('/domain/delivery-readiness');
    ElMessage[readiness.value.allReady ? 'success' : 'warning'](
      readiness.value.allReady ? '投放链路全部就绪' : '检测完成，仍有项目待配置',
    );
  } catch (error) { ElMessage.error(error.message); }
  finally { readinessLoading.value = false; }
}

const readinessItems = computed(() => {
  if (!readiness.value) return [];
  const labels = {
    shortLinkServiceConfigured: '短链服务已配置',
    existingShortLinkReachable: '现有短链可访问',
    landingReachable: '素材落地页可访问',
    shareMetadataReady: '标题/简介/封面完整',
    selfShortLinkMetadataReady: '自建短链卡片元数据完整',
    shortLinkHttps: '短链使用 HTTPS',
    landingHttps: '落地页使用 HTTPS',
    cardTargetReady: '短链目标为独立卡片页',
    serverOgMode: '服务端 Open Graph 模式',
  };
  return Object.entries(labels).map(([key, label]) => ({ key, label, passed: Boolean(readiness.value.checks?.[key]) }));
});

function openAddDomain() {
  Object.assign(domainForm, { id: '', domain: '', remark: '', isEnabled: true, isPrimary: false });
  domainEditVisible.value = true;
}

function openEditDomain(item) {
  Object.assign(domainForm, {
    id: String(item.id), domain: item.domain, remark: item.remark || '',
    isEnabled: Boolean(item.is_enabled), isPrimary: Boolean(item.is_primary),
  });
  domainEditVisible.value = true;
}

async function saveDomain() {
  try {
    const payload = {
      domain: domainForm.domain, type: 'self_hosted', platform: 'self',
      remark: domainForm.remark, isEnabled: domainForm.isEnabled,
      ...(!domainForm.id ? { isPrimary: domainForm.isPrimary } : {}),
    };
    await request(domainForm.id ? `/domain/${domainForm.id}` : '/domain', {
      method: domainForm.id ? 'PUT' : 'POST', body: JSON.stringify(payload),
    });
    domainEditVisible.value = false;
    ElMessage.success(domainForm.id ? '域名已更新' : '域名已加入域名池');
    await loadDomainPool();
  } catch (error) { ElMessage.error(error.message); }
}

async function setPrimaryDomain(item) {
  try {
    await request('/domain/switch', { method: 'POST', body: JSON.stringify({ domainId: item.id }) });
    ElMessage.success('主域名已设置'); await loadDomainPool();
  } catch (error) { ElMessage.error(error.message); }
}

async function toggleDomain(item) {
  try {
    await request(`/domain/${item.id}/toggle`, {
      method: 'POST', body: JSON.stringify({ enabled: !item.is_enabled }),
    });
    ElMessage.success(item.is_enabled ? '域名已停用' : '域名已启用'); await loadDomainPool();
  } catch (error) { ElMessage.error(error.message); }
}

async function removeDomain(item) {
  try {
    await ElMessageBox.confirm(`确定从域名池删除“${item.domain}”吗？`, '删除域名', { type: 'warning' });
    await request(`/domain/${item.id}`, { method: 'DELETE' });
    ElMessage.success('域名已删除'); await loadDomainPool();
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '操作已取消'); }
}

function dashboardCards() {
  const d = dashboardData.value;
  if (!d) return [];
  const cards = [
    ['总素材数量', d.materials.total, `有效素材 ${d.materials.effective}`],
    ['当日上传素材', d.materials.todayUploads, `15天内到期 ${d.materials.expiring}`],
    ['7日上传素材', d.materials.weekUploads, `30日上传 ${d.materials.monthUploads}`],
  ];
  if (isPlatformAdmin.value) {
    cards.push(['业务组', d.people.businessGroups, `当前有效 ${d.people.effectiveGroups}`]);
  }
  cards.push(
    ['推广员数量', d.people.promoters, `有效推广员 ${d.people.effectivePromoters}`],
    ['总推广链接', d.delivery.totalLinks, `总访问量 ${d.delivery.visits}`],
    ['总播放量', d.delivery.starts, `完整播放 ${d.delivery.completes}`],
    ['总体完播率', `${d.delivery.completionRate}%`, `今日播放 ${d.delivery.todayStarts}`],
  );
  return cards;
}

function toggleMaterial(id) {
  const next = new Set(expandedMaterials.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expandedMaterials.value = next;
}

async function generateLink(material, platform = 'self', selectedMode) {
  try {
    const isSuolink = platform === 'suolink';
    const wechatCardMode = TEXT_DESCRIPTION_EXPERIMENT_ENABLED
      ? selectedMode || cardModeSelections[String(material.id)] || 'standard'
      : 'standard';
    const result = await request(isSuolink ? '/shortlink/generate' : '/shortlink/self-create', {
      method: 'POST',
      body: JSON.stringify({
        videoId: material.id,
        wechatCardMode,
        ...(isSuolink ? { platform: 'suolink', allowFallback: false } : {}),
      }),
    });
    const copied = await copyText(result.shortUrl || result.short_url || '');
    const linkLabel = wechatCardMode === 'text_description'
      ? '全新纯文字实验短链'
      : isSuolink ? 'Suolink 链接' : '自建 /s/ 链接';
    const rejectedDomains = Array.isArray(result.providerRejectedDomains)
      ? result.providerRejectedDomains.filter(Boolean)
      : [];
    if (isSuolink && rejectedDomains.length) {
      ElMessage.warning({
        message: `${linkLabel}已生成${copied ? '并复制' : ''}；${rejectedDomains.join('、')} 被 Suolink 拒绝，请检查这些域名是否已绑定到当前 API Key`,
        duration: 8000,
      });
      await loadMaterials();
      return;
    }
    ElMessage[copied ? 'success' : 'warning'](
      copied
        ? `${linkLabel}已生成并复制`
        : `${linkLabel}已生成，但自动复制失败`,
    );
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
}

function generateExperimentalLink(material) {
  if (!TEXT_DESCRIPTION_EXPERIMENT_ENABLED) return;
  cardModeSelections[String(material.id)] = 'text_description';
  return generateLink(material, 'self', 'text_description');
}

async function generateAbLinks(material) {
  if (!TEXT_DESCRIPTION_EXPERIMENT_ENABLED) return;
  try {
    const result = await request('/shortlink/self-create-ab', {
      method: 'POST',
      body: JSON.stringify({ videoId: material.id }),
    });
    Object.assign(abResult, {
      standard: result.standard?.shortUrl || result.standard?.short_url || '',
      textDescription: result.textDescription?.shortUrl
        || result.textDescription?.short_url
        || '',
    });
    abResultVisible.value = true;
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
}

async function copyAbLinks() {
  const copied = await copyText(
    `A（标准图文）：${abResult.standard}\nB（纯文字实验）：${abResult.textDescription}`,
  );
  ElMessage[copied ? 'success' : 'warning'](
    copied ? 'A/B 测试链接已复制' : '自动复制失败，请手动复制两个链接',
  );
}

async function toggleShortLink(link) {
  try {
    const enabled = link.status !== 'active';
    await request('/shortlink/toggle', {
      method: 'POST',
      body: JSON.stringify({ shortLinkId: link.id, enabled }),
    });
    ElMessage.success(enabled ? '短链已启用' : '短链已停用');
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
}

async function deleteShortLink(link) {
  try {
    await ElMessageBox.confirm(`确定删除自建短链“${link.short_url}”吗？访问日志会保留。`, '删除短链', {
      type: 'warning',
    });
    await request(`/shortlink/${link.id}`, { method: 'DELETE' });
    ElMessage.success('自建短链已删除');
    await loadMaterials();
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.message || '操作已取消');
  }
}

async function copyText(value) {
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // HTTP/IP deployments often block the modern Clipboard API. Fall through
      // to the selection-based browser copy command for those environments.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  Object.assign(textarea.style, {
    position: 'fixed', left: '-9999px', top: '0', opacity: '0', pointerEvents: 'none',
  });
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

async function copyLink(link) {
  const copied = await copyText(link.short_url);
  ElMessage[copied ? 'success' : 'error'](copied ? '链接已复制；可直接粘贴测试，微信未展开时请打开后从右上角分享' : '自动复制失败，请检查浏览器剪贴板权限');
}

function validatedWechatShareUrl(link) {
  const raw = String(link?.short_url || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('推广短网址格式无效，无法生成二维码');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || /(?:^|\/)play(?:\/|$)/i.test(url.pathname)
  ) {
    throw new Error('推广短网址必须是无参数的 HTTPS 卡片入口，不能指向播放页');
  }
  if (link.platform === 'self') {
    if (!/^\/s\/[A-Za-z0-9]{6,8}$/.test(url.pathname)) {
      throw new Error('自建链接二维码只能使用当前域名池中的 HTTPS /s/{shortCode} 入口');
    }
  } else if (link.platform !== 'suolink') {
    throw new Error('链接平台无效，无法生成二维码');
  }
  if (/fileId|shortLinkId|psign|signature|secret|key=/i.test(url.toString())) {
    throw new Error('推广短网址包含禁止公开的播放参数');
  }
  return url.toString();
}

async function openWechatShare(material, link) {
  if (link.status !== 'active' || link.needs_regeneration) {
    ElMessage.warning('只有已启用且卡片入口有效的推广链接可以生成微信分享二维码');
    return;
  }
  wechatShareLoading.value = true;
  try {
    const shareUrl = validatedWechatShareUrl(link);
    const qrDataUrl = await QRCode.toDataURL(shareUrl, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#07111f', light: '#ffffff' },
    });
    Object.assign(wechatShareForm, {
      platform: link.platform,
      title: link.card_title || material.title || '视频播放',
      coverUrl: link.wechat_card_mode === 'text_description'
        ? ''
        : resolveAssetUrl(link.card_cover_url || material.cover_url)
          || `${window.location.origin}/wechat-share-default.png`,
      link: shareUrl,
      qrDataUrl,
      wechatCardMode: link.wechat_card_mode || 'standard',
    });
    wechatShareVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || '微信分享二维码生成失败');
  } finally {
    wechatShareLoading.value = false;
  }
}

async function copyWechatShareLink() {
  const copied = await copyText(wechatShareForm.link);
  ElMessage[copied ? 'success' : 'error'](
    copied ? '原始推广短网址已复制' : '复制失败，请检查浏览器剪贴板权限',
  );
}

function resetWechatShareDialog() {
  Object.assign(wechatShareForm, {
    platform: '', title: '', coverUrl: '', link: '', qrDataUrl: '', wechatCardMode: 'standard',
  });
}

function resolveAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(https?:|blob:|data:)/i.test(raw)) return raw;
  try {
    const apiOrigin = new URL(API, window.location.origin).origin;
    return new URL(raw, raw.startsWith('/api/') ? apiOrigin : window.location.origin).toString();
  } catch {
    return raw;
  }
}

function clearShareCardCoverFile() {
  if (shareCardForm.coverUrl.startsWith('blob:')) URL.revokeObjectURL(shareCardForm.coverUrl);
  shareCardForm.coverFile = null;
}

async function openShareCard(material, link) {
  if (link.platform === 'suolink' && link.needs_regeneration) {
    ElMessage.warning('此 Suolink 短链需重新生成后才能制作卡片');
    return;
  }
  if (link.platform === 'suolink' && link.needs_regeneration) {
    const copied = await copyText(link.short_url || '');
    await ElMessageBox.alert(
      `${copied ? '短链接已复制。' : '请先手动复制该短链接。'}登录 Suolink 后，在短链接管理中找到这条链接，点击“分享”，再填写卡片图片、标题和描述。`,
      'Suolink 卡片设置',
      { confirmButtonText: '打开 Suolink' },
    );
    return;
  }

  Object.assign(shareCardForm, {
    materialId: String(material.id),
    linkId: String(link.id),
    link: link.short_url || '',
    title: material.title || '视频播放',
    description: material.description || '点击查看视频素材',
    coverUrl: link.wechat_card_mode === 'text_description'
      ? ''
      : resolveAssetUrl(material.cover_url) || `${window.location.origin}/wechat-share-default.png`,
    coverFile: null,
    wechatCardMode: link.wechat_card_mode || 'standard',
  });
  shareCardForm.title = link.card_title || material.title || shareCardForm.title;
  shareCardForm.description = link.card_description || material.description || shareCardForm.description;
  if (shareCardForm.wechatCardMode === 'standard') {
    shareCardForm.coverUrl = resolveAssetUrl(link.card_cover_url || material.cover_url) || shareCardForm.coverUrl;
  }
  shareCardVisible.value = true;
}

function selectShareCardCover(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    ElMessage.warning('卡片图片仅支持 JPG、PNG 或 WebP 格式');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning('卡片图片不能超过 5MB');
    return;
  }
  clearShareCardCoverFile();
  shareCardForm.coverFile = file;
  shareCardForm.coverUrl = URL.createObjectURL(file);
}

function resetShareCardDialog() {
  clearShareCardCoverFile();
  Object.assign(shareCardForm, {
    materialId: '', linkId: '', link: '', title: '', description: '', coverUrl: '', coverFile: null, wechatCardMode: 'standard',
  });
}

async function saveLegacyShareCard() {
  if (!shareCardForm.title.trim() || !shareCardForm.description.trim()) {
    ElMessage.warning('请填写卡片标题和描述');
    return;
  }

  shareCardSaving.value = true;
  try {
    if (canManageMaterialAdmin.value) {
      if (shareCardForm.coverFile) {
        const previewUrl = shareCardForm.coverUrl;
        const formData = new FormData();
        formData.append('cover', shareCardForm.coverFile);
        const uploaded = await request(`/management/materials/${shareCardForm.materialId}/card-cover`, {
          method: 'POST', body: formData,
        });
        shareCardForm.coverUrl = resolveAssetUrl(uploaded.coverUrl || uploaded.cover_url);
        shareCardForm.coverFile = null;
        if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      }
      await request(`/management/materials/${shareCardForm.materialId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: shareCardForm.title,
          description: shareCardForm.description,
        }),
      });
    }
    const copied = await copyText(shareCardForm.link);
    if (!copied) throw new Error('卡片链接复制失败，请检查浏览器剪贴板权限');
    shareCardVisible.value = false;
    ElMessage.success('卡片链接已复制；可直接粘贴发送，微信未展开时请在微信内打开后从右上角分享');
    if (canManageMaterialAdmin.value) await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
  finally { shareCardSaving.value = false; }
}

async function saveShareCardV2() {
  if (!shareCardForm.title.trim() || !shareCardForm.description.trim()) {
    ElMessage.warning('请填写卡片标题和描述');
    return;
  }
  shareCardSaving.value = true;
  try {
    if (shareCardForm.wechatCardMode === 'standard' && shareCardForm.coverFile) {
      const previewUrl = shareCardForm.coverUrl;
      const formData = new FormData();
      formData.append('cover', shareCardForm.coverFile);
      const uploaded = await request(`/management/short-links/${shareCardForm.linkId}/card-cover`, {
        method: 'POST', body: formData,
      });
      shareCardForm.coverUrl = resolveAssetUrl(uploaded.coverUrl || uploaded.cover_url);
      shareCardForm.coverFile = null;
      if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    }
    await request(`/management/short-links/${shareCardForm.linkId}/card`, {
      method: 'PUT',
      body: JSON.stringify({
        title: shareCardForm.title,
        description: shareCardForm.description,
        ...(shareCardForm.wechatCardMode === 'standard'
          ? { coverUrl: shareCardForm.coverUrl }
          : {}),
      }),
    });
    const copied = await copyText(shareCardForm.link);
    if (!copied) throw new Error('卡片链接复制失败，请检查浏览器剪贴板权限');
    shareCardVisible.value = false;
    ElMessage.success('卡片已保存并复制链接');
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
  finally { shareCardSaving.value = false; }
}

const saveShareCard = saveShareCardV2;

function editMaterial(material) {
  Object.assign(editMaterialForm, {
    id: String(material.id),
    title: material.title || '',
    description: material.description || '',
    businessGroupId: material.business_group_id ? String(material.business_group_id) : '',
    materialGroupId: material.material_group_id ? String(material.material_group_id) : '',
  });
  materialEditVisible.value = true;
}

function handleEditMaterialBusinessGroupChange() {
  const selectedGroup = materialGroups.value.find(
    (group) => String(group.id) === String(editMaterialForm.materialGroupId),
  );
  if (selectedGroup && String(selectedGroup.business_group_id) !== String(editMaterialForm.businessGroupId)) {
    editMaterialForm.materialGroupId = '';
  }
}

async function saveEditedMaterial() {
  if (!editMaterialForm.title.trim()) {
    ElMessage.warning('请输入素材名称');
    return;
  }
  try {
    await request(`/management/materials/${editMaterialForm.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: editMaterialForm.title,
        description: editMaterialForm.description,
        ...(isPlatformAdmin.value ? { businessGroupId: editMaterialForm.businessGroupId || null } : {}),
        materialGroupId: editMaterialForm.materialGroupId || null,
      }),
    });
    materialEditVisible.value = false;
    ElMessage.success('素材信息已更新');
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
}

async function toggleMaterialStatus(material) {
  try {
    const status = material.status === 'disabled' ? 'ready' : 'disabled';
    await request(`/management/materials/${material.id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    ElMessage.success(status === 'ready' ? '素材已恢复' : '素材已暂停');
    await loadMaterials();
  } catch (error) { ElMessage.error(error.message); }
}

async function deleteMaterial(material) {
  try {
    await ElMessageBox.confirm(`确定删除“${material.title}”吗？云端媒资也将被删除。`, '删除素材', { type: 'warning' });
    await request(`/video/${material.id}`, { method: 'DELETE' });
    ElMessage.success('素材已删除');
    await loadMaterials();
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '操作已取消'); }
}

async function addMaterialGroup() {
  try {
    const { value } = await ElMessageBox.prompt('请输入素材组名称', '添加素材组', { inputPattern: /\S+/, inputErrorMessage: '名称不能为空' });
    await request('/management/material-groups', {
      method: 'POST', body: JSON.stringify({ name: value, businessGroupId: materialGroupBusinessId.value || uploadForm.businessGroupId }),
    });
    ElMessage.success('素材组已添加'); await loadMaterialGroups();
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '操作已取消'); }
}

async function toggleMaterialGroup(group) {
  try {
    await request(`/management/material-groups/${group.id}`, { method: 'PUT', body: JSON.stringify({ isEnabled: !group.is_enabled }) });
    await loadMaterialGroups();
  } catch (error) { ElMessage.error(error.message); }
}

async function deleteMaterialGroup(group) {
  try {
    await ElMessageBox.confirm(`确定删除素材组“${group.name}”吗？`, '删除素材组', { type: 'warning' });
    await request(`/management/material-groups/${group.id}`, { method: 'DELETE' }); await loadMaterialGroups();
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '操作已取消'); }
}

function loadVodSdk() {
  if (window.TcVod) return Promise.resolve(window.TcVod);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = VOD_SDK; script.async = true;
    script.onload = () => window.TcVod ? resolve(window.TcVod) : reject(new Error('上传组件初始化失败'));
    script.onerror = () => reject(new Error('云端上传组件加载失败'));
    document.head.appendChild(script);
  });
}

function pickFile(event, type) {
  const file = event.target.files?.[0] || null;
  event.target.value = '';
  if (type === 'video') {
    if (file && file.size > MAX_VIDEO_UPLOAD_SIZE_BYTES) {
      uploadForm.videoFile = null;
      ElMessage.error('视频文件不能超过 800MB，请压缩或重新选择');
      return;
    }
    uploadForm.videoFile = file;
    if (file && !uploadForm.title) uploadForm.title = file.name.replace(/\.[^.]+$/, '');
    return;
  }
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    ElMessage.warning('封面图片仅支持 JPG、PNG 或 WebP 格式');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.warning('封面图片不能超过 5MB');
    return;
  }
  uploadForm.coverFile = file;
}

async function submitUpload() {
  if (!uploadForm.videoFile || !uploadForm.title || !uploadForm.businessGroupId || !uploadForm.materialGroupId) {
    ElMessage.warning('请完整选择业务组、素材组，填写名称并选择视频'); return;
  }
  if (uploadForm.videoFile.size > MAX_VIDEO_UPLOAD_SIZE_BYTES) {
    uploadForm.videoFile = null;
    ElMessage.error('视频文件不能超过 800MB，请压缩或重新选择');
    return;
  }
  uploading.value = true; uploadProgress.value = 0;
  try {
    const TcVodModule = await loadVodSdk();
    const TcVod = TcVodModule.default || TcVodModule;
    if (typeof TcVod !== 'function') throw new Error('云端上传组件格式不兼容，请刷新后重试');
    const appId = Number(import.meta.env.VITE_TENCENT_APP_ID);
    const tcVod = new TcVod({
      appId,
      getSignature: async () => (await request('/video/upload', {
        method: 'POST',
        body: JSON.stringify({ fileSize: uploadForm.videoFile.size }),
      })).signature,
    });
    // Tencent VOD remains responsible for the video upload. Custom covers are
    // persisted by our backend after the material has an id, so they never
    // depend on a temporary SDK cover URL.
    const task = tcVod.upload({ mediaFile: uploadForm.videoFile, mediaName: uploadForm.title });
    task.on('media_progress', (info) => { uploadProgress.value = Math.min(99, Math.round(Number(info.percent || 0) * 100)); });
    const result = await task.done();
    const material = await request('/video/complete', {
      method: 'POST',
      body: JSON.stringify({
        fileId: String(result.fileId), title: uploadForm.title, description: uploadForm.description,
        videoUrl: result.video?.url || null,
        // The VOD-generated cover is only the default when no custom cover was
        // selected. A custom image is uploaded to the public local store below.
        coverUrl: uploadForm.coverFile ? null : (result.cover?.url || null),
        businessGroupId: uploadForm.businessGroupId, materialGroupId: uploadForm.materialGroupId,
      }),
    });
    if (uploadForm.coverFile) {
      const formData = new FormData();
      formData.append('cover', uploadForm.coverFile);
      const uploaded = await request(`/management/materials/${material.id}/card-cover`, {
        method: 'POST',
        body: formData,
      });
      // Keep the final public URL in the local material state before the list
      // refresh, so any immediate preview never uses a blob URL.
      material.cover_url = resolveAssetUrl(uploaded.coverUrl || uploaded.cover_url);
    }
    uploadProgress.value = 100; ElMessage.success('素材上传完成，推广链接已自动生成');
    Object.assign(uploadForm, { title: '', description: '', videoFile: null, coverFile: null });
    await selectPage('materials');
  } catch (error) { ElMessage.error(error.message || '上传失败'); }
  finally { uploading.value = false; }
}

async function saveUser(role) {
  try {
    await request('/management/users', {
      method: 'POST', body: JSON.stringify({ ...userForm, role, expiresAt: userForm.expiresAt || null }),
    });
    ElMessage.success('账号添加成功');
    Object.assign(userForm, { name: '', phone: '', password: '', role: 'general_user', expiresAt: '' });
    await selectPage(role === 'system_admin' ? 'admins' : 'promoters');
  } catch (error) { ElMessage.error(error.message); }
}

async function changeUserStatus(item) {
  try {
    await request(`/management/users/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: item.status === 'active' ? 'disabled' : 'active' }) });
    ElMessage.success('状态已更新'); await loadUsers();
  } catch (error) { ElMessage.error(error.message); }
}

async function removeUser(item) {
  try {
    await ElMessageBox.confirm(`确定停用账号“${item.name}”吗？`, '停用账号', { type: 'warning' });
    await request(`/management/users/${item.id}`, { method: 'DELETE' }); await loadUsers();
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '操作已取消'); }
}

function editUser(item) {
  Object.assign(editUserForm, {
    id: String(item.id), name: item.name || '', phone: item.phone || '', password: '',
    role: item.role, businessGroupId: item.business_group_id ? String(item.business_group_id) : '',
    expiresAt: formatFormDate(item.expires_at), status: item.status || 'active',
  });
  userEditVisible.value = true;
}

async function saveEditedUser() {
  try {
    const payload = {
      name: editUserForm.name, phone: editUserForm.phone,
      expiresAt: editUserForm.expiresAt || null, status: editUserForm.status,
    };
    if (editUserForm.password) payload.password = editUserForm.password;
    if (editUserForm.role === 'general_user' && isPlatformAdmin.value) {
      payload.businessGroupId = editUserForm.businessGroupId;
    }
    await request(`/management/users/${editUserForm.id}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    userEditVisible.value = false;
    ElMessage.success('账号资料已更新');
    await loadUsers();
  } catch (error) { ElMessage.error(error.message); }
}

function editBusinessGroup(item) {
  Object.assign(editGroupForm, {
    id: String(item.id), name: item.name || '', managerName: item.manager_name || '',
    managerPhone: item.manager_phone || '', password: '',
    expiresAt: formatFormDate(item.expires_at), status: item.status || 'active',
  });
  groupEditVisible.value = true;
}

async function saveEditedBusinessGroup() {
  try {
    const payload = {
      name: editGroupForm.name, managerName: editGroupForm.managerName,
      managerPhone: editGroupForm.managerPhone, expiresAt: editGroupForm.expiresAt || null,
      status: editGroupForm.status,
    };
    if (editGroupForm.password) payload.password = editGroupForm.password;
    await request(`/management/business-groups/${editGroupForm.id}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    groupEditVisible.value = false;
    ElMessage.success('业务组资料已更新');
    await loadBusinessGroups();
  } catch (error) { ElMessage.error(error.message); }
}

async function saveBusinessGroup() {
  try {
    await request('/management/business-groups', { method: 'POST', body: JSON.stringify(groupForm) });
    ElMessage.success('业务组及管理员账号已创建');
    Object.assign(groupForm, { name: '', managerName: '', managerPhone: '', password: '', expiresAt: '' });
    await selectPage('business-groups');
  } catch (error) { ElMessage.error(error.message); }
}

onMounted(async () => {
  try {
    user.value = await request('/management/auth/me');
    localStorage.setItem('demo18_user', JSON.stringify(user.value));
    await Promise.all([loadDashboard(), loadBusinessGroups(), loadMaterialGroups()]);
  } catch (error) { ElMessage.error(error.message); }
});
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <button class="brand-button" type="button" @click="selectPage('dashboard')">
        <span class="brand-icon">▶</span>
        <span><strong>产品素材资源管理系统</strong><small>VIDEO ASSET CENTER</small></span>
      </button>
      <div class="account-summary" v-if="user">
        <span>用户：<b>{{ user.name }}</b></span>
        <span>登录账号：{{ user.phone }}</span>
        <span>业务组：{{ user.businessGroupName || '平台管理' }}</span>
        <span class="account-valid">● 账号有效</span>
        <button type="button" @click="logout">退出</button>
      </div>
    </header>

    <div class="admin-layout">
      <aside class="sidebar">
        <div class="role-badge">{{ roleLabels[user?.role] || '加载中' }}</div>
        <nav>
          <section v-for="section in menus" :key="section.title" class="menu-section">
            <h3>{{ section.icon }}&nbsp; {{ section.title }}</h3>
            <button v-for="item in section.items" :key="item.key" type="button" :class="{ active: activePage === item.key }" @click="selectPage(item.key)">
              {{ item.label }}
            </button>
          </section>
        </nav>
      </aside>

      <main class="admin-content" v-loading="loading">
        <div class="content-heading">
          <div><span class="heading-kicker">CONTROL CENTER</span><h1>{{ pageTitle }}</h1></div>
          <span v-if="resultCount !== null" class="result-count">{{ resultCount }} 条记录</span>
        </div>

        <template v-if="activePage === 'dashboard'">
          <div class="welcome-panel">
            <div><span>今日工作台</span><h2>{{ user?.name }}，欢迎回来</h2><p>查看素材投放、推广人员与近期到期情况。</p></div>
            <button type="button" @click="selectPage('upload')" v-if="canManageMaterialAdmin">＋ 上传新素材</button>
          </div>
          <div class="metric-grid">
            <article v-for="(card, index) in dashboardCards()" :key="card[0]" :class="`metric-card tone-${index % 4}`">
              <span>{{ card[0] }}</span><strong>{{ card[1] }}</strong><small>{{ card[2] }}</small>
            </article>
          </div>
          <div class="quick-actions">
            <button type="button" @click="selectPage('materials')"><b>素材库</b><span>查看与投放视频素材 →</span></button>
            <button type="button" @click="selectPage('promoters')"><b>推广员</b><span>维护账号和业务关系 →</span></button>
            <button type="button" @click="selectPage('expiring')"><b>到期提醒</b><span>处理 15 天内到期账号 →</span></button>
          </div>
        </template>

        <template v-else-if="activePage === 'materials'">
          <div class="filter-bar">
            <el-select v-if="isPlatformAdmin" v-model="materialFilter.businessGroupId" clearable placeholder="全部业务组" @change="loadMaterials"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select>
            <el-select v-model="materialFilter.materialGroupId" clearable placeholder="全部素材组" @change="loadMaterials"><el-option v-for="g in materialGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select>
            <el-input v-model="materialFilter.keyword" clearable placeholder="搜索素材名称或简介" @keyup.enter="loadMaterials" />
           <el-button class="primary-action" @click="loadMaterials">查询</el-button>
           <el-button v-if="canManageMaterialAdmin" class="upload-shortcut" @click="selectPage('upload')">上传素材</el-button>
          </div>
          <section v-if="canViewVisitQuota && myVisitQuota" class="business-quota-summary" aria-label="本月访问额度">
            <div class="business-quota-heading">
              <div>
                <span>本业务组本月访问额度</span>
                <b>{{ myVisitQuota.period }}</b>
              </div>
              <button type="button" :disabled="myVisitQuotaLoading" @click="loadMyVisitQuota">{{ myVisitQuotaLoading ? '刷新中…' : '刷新' }}</button>
            </div>
            <div class="business-quota-metrics">
              <div><span>本月已使用</span><strong>{{ Number(myVisitQuota.usedQuota || 0).toLocaleString() }} 次</strong></div>
              <div><span>剩余次数</span><strong :class="{ 'quota-empty': myVisitQuota.remainingQuota === 0, 'quota-warning': myVisitQuota.remainingQuota > 0 && myVisitQuota.remainingQuota <= Math.max(10, Math.floor((myVisitQuota.baseQuota + myVisitQuota.extraQuota) * 0.1)) }">{{ Number(myVisitQuota.remainingQuota || 0).toLocaleString() }} 次</strong></div>
              <div><span>本月总额度</span><strong>{{ Number(myVisitQuota.baseQuota + myVisitQuota.extraQuota).toLocaleString() }} 次</strong></div>
              <div><span>本月基础额度</span><strong>{{ Number(myVisitQuota.baseQuota || 0).toLocaleString() }} 次</strong></div>
              <div><span>本月额外额度</span><strong>{{ Number(myVisitQuota.extraQuota || 0).toLocaleString() }} 次</strong></div>
            </div>
          </section>
          <div class="material-list">
            <article v-for="(material, index) in materials" :key="material.id" class="material-card">
              <div class="material-main">
                <span class="material-index">{{ index + 1 }}</span>
                <div class="cover"><img v-if="material.cover_url" :src="material.cover_url" alt="素材封面" /><span v-else>▶</span></div>
                <div class="material-copy"><h3>{{ material.title }}</h3><p>{{ material.description || '暂无素材简介' }}</p><small>{{ material.business_group_name || '未分组' }} · {{ material.material_group_name || '未分类' }}</small></div>
                <div class="material-stat"><span>访问次数</span><b>{{ material.play_count }}</b></div>
                <div class="material-stat"><span>完整播放</span><b>{{ material.complete_count }}</b></div>
                <div class="material-stat"><span>完播率</span><b>{{ material.completion_rate }}%</b></div>
                <span class="status-pill" :class="material.status">{{ statusLabels[material.status] || material.status }}</span>
                <div class="row-actions">
                  <button type="button" @click="toggleMaterial(material.id)">{{ expandedMaterials.has(material.id) ? '收起链接' : '推广链接' }}</button>
                  <button v-if="canManageMaterialAdmin" type="button" @click="editMaterial(material)">编辑</button>
                  <button v-if="canManageMaterialAdmin" type="button" @click="toggleMaterialStatus(material)">{{ material.status === 'disabled' ? '恢复' : '暂停' }}</button>
                  <button v-if="canManageMaterialAdmin" class="danger" type="button" @click="deleteMaterial(material)">删除</button>
                </div>
              </div>
              <div v-if="expandedMaterials.has(material.id)" class="link-panel">
                <div class="link-summary">
                  <div>
                    <span>链接数量：{{ material.short_links.length }}</span>
                    <small>每次生成都会创建全新短码；不要用已经被微信缓存的旧短码切换模式测试。</small>
                    <div v-if="TEXT_DESCRIPTION_EXPERIMENT_ENABLED" class="card-mode-selector" role="radiogroup" aria-label="微信卡片模式">
                      <b>微信卡片模式：</b>
                      <label><input v-model="cardModeSelections[String(material.id)]" type="radio" value="standard" /> 标准图文卡片</label>
                      <label><input v-model="cardModeSelections[String(material.id)]" type="radio" value="text_description" /> 纯文字简介实验</label>
                    </div>
                    <p v-if="TEXT_DESCRIPTION_EXPERIMENT_ENABLED && cardModeSelections[String(material.id)] === 'text_description'" class="experiment-warning">该模式会删除全部封面和图片元数据，并补充多种结构化简介字段，用于测试微信是否选择纯文字简介卡片。微信展示结果由客户端决定，系统不能保证一定显示简介。必须生成全新短码测试。</p>
                  </div>
                  <div class="link-generate-actions">
                    <button class="suolink-generate" type="button" @click="generateLink(material, 'suolink', 'standard')">＋生成万象链接</button>
                    <button type="button" @click="generateLink(material, 'self')">＋应急短链链接</button>
                    <button v-if="TEXT_DESCRIPTION_EXPERIMENT_ENABLED" class="experiment-generate" type="button" @click="generateExperimentalLink(material)">生成全新实验短链</button>
                    <button v-if="TEXT_DESCRIPTION_EXPERIMENT_ENABLED" class="ab-generate" type="button" @click="generateAbLinks(material)">生成 A/B 测试短链</button>
                  </div>
                </div>
                <div v-if="!material.short_links.length" class="empty-inline">暂无推广链接</div>
                <div v-for="(link, linkIndex) in material.short_links" :key="link.id" class="link-row">
                  <span>{{ linkIndex + 1 }}</span><a :href="link.short_url" target="_blank">{{ link.short_url }}</a><span class="link-platform-tag" :class="link.platform">{{ link.platform === 'suolink' ? 'Suolink' : '自建' }}</span><span class="card-mode-tag" :class="link.wechat_card_mode">{{ link.wechat_card_mode === 'text_description' ? '纯文字实验' : '标准图文' }}</span><span>{{ link.status === 'active' ? '已启用' : link.status === 'expired' ? '已过期' : '已停用' }}</span><span>访问 {{ link.clicks }}</span><span class="card-status-tag" :class="link.needs_regeneration ? 'needs-regeneration' : link.card_status">{{ link.needs_regeneration ? '需重新生成' : link.card_status === 'ready' ? '卡片已就绪' : '待制作' }}</span><span>{{ formatDate(link.created_at) }}</span><div class="link-actions"><button type="button" :disabled="link.needs_regeneration" @click="openShareCard(material, link)">{{ link.needs_regeneration ? '需重新生成' : '设置卡片' }}</button><button type="button" :disabled="link.status !== 'active' || link.needs_regeneration || wechatShareLoading" @click="openWechatShare(material, link)">微信分享</button><button type="button" @click="copyLink(link)">复制链接</button><button type="button" :disabled="link.status === 'expired'" @click="toggleShortLink(link)">{{ link.status === 'active' ? '停用' : '启用' }}</button><button v-if="link.platform === 'self'" class="danger" type="button" @click="deleteShortLink(link)">删除</button></div>
                </div>
              </div>
            </article>
            <el-empty v-if="!materials.length" description="暂无符合条件的素材" />
          </div>
        </template>

        <template v-else-if="activePage === 'material-groups'">
          <div class="section-toolbar"><div><span>素材组数量</span><b>{{ materialGroups.length }}</b></div><el-select v-if="isPlatformAdmin" v-model="materialGroupBusinessId" placeholder="选择业务组" @change="loadMaterialGroups"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></div>
          <div class="group-panel"><div class="group-intro"><h3>本业务组下的素材分类维护</h3><p>关闭素材组后，上传新素材时将不能再选择该分组。</p></div><div class="group-list"><div v-for="group in materialGroups" :key="group.id" class="group-row"><div><b>{{ group.name }}</b><span>{{ group.business_group_name }} · {{ group.material_count }} 个素材</span></div><el-switch :model-value="Boolean(group.is_enabled)" @change="toggleMaterialGroup(group)" /><button type="button" @click="deleteMaterialGroup(group)">删除</button></div></div><div class="group-buttons"><button type="button" @click="addMaterialGroup">＋ 添加素材组</button></div></div>
        </template>

        <template v-else-if="activePage === 'upload'">
          <div class="form-card upload-form">
            <div class="form-section-title"><span>01</span><div><h3>归属与授权</h3><p>为素材选择业务组和素材分类。</p></div></div>
            <div class="form-grid two"><label><span>选择业务组</span><el-select v-model="uploadForm.businessGroupId" @change="loadMaterialGroups"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label><label><span>选择素材组</span><el-select v-model="uploadForm.materialGroupId"><el-option v-for="g in materialGroups.filter(x => !uploadForm.businessGroupId || String(x.business_group_id) === String(uploadForm.businessGroupId))" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label></div>
            <div class="form-section-title"><span>02</span><div><h3>素材信息</h3><p>标题与简介将用于后台识别和微信卡片展示。</p></div></div>
            <div class="form-grid"><label><span>素材名称</span><el-input v-model="uploadForm.title" placeholder="请输入素材标题" /></label><label><span>素材简介</span><el-input v-model="uploadForm.description" type="textarea" :rows="3" placeholder="请输入广告内容简介" /></label></div>
            <div class="form-section-title"><span>03</span><div><h3>上传文件</h3><p>视频将安全直传至云端存储。</p></div></div>
  <div class="upload-zones"><label class="upload-zone"><input type="file" accept="video/mp4,video/*" @change="pickFile($event, 'video')" /><strong>▶</strong><b>{{ uploadForm.videoFile?.name || '选择视频文件' }}</b><span>建议 MP4，文件不超过 800MB</span></label><label class="upload-zone cover-zone"><input type="file" accept="image/jpeg,image/png,image/webp" @change="pickFile($event, 'cover')" /><strong>＋</strong><b>{{ uploadForm.coverFile?.name || '上传封面图片' }}</b><span>支持 JPG、PNG、WebP，文件不超过 5MB</span></label></div>
            <el-progress v-if="uploading || uploadProgress" :percentage="uploadProgress" />
            <div class="form-footer"><button type="button" :disabled="uploading" @click="submitUpload">{{ uploading ? '正在上传…' : '保存素材' }}</button><p>素材默认保留 3 天，到期后视频自动删除，访问统计数据继续保留。</p></div>
          </div>
        </template>

        <template v-else-if="['promoters', 'admins', 'expiring', 'business-groups'].includes(activePage)">
          <div v-if="activePage === 'business-groups'" class="filter-bar"><el-button class="primary-action" @click="selectPage('add-business-group')">＋ 添加业务组</el-button></div>
          <div class="data-table-wrap">
            <table v-if="activePage === 'business-groups'" class="data-table"><thead><tr><th>序号</th><th>业务组名称</th><th>管理员</th><th>登录手机</th><th>成员数</th><th>添加时间</th><th>到期时间</th><th>本月访问</th><th>剩余次数</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="(item, i) in businessGroups" :key="item.id"><td>{{ i + 1 }}</td><td><b>{{ item.name }}</b></td><td>{{ item.manager_name || '-' }}</td><td>{{ item.manager_phone || '-' }}</td><td>{{ item.member_count }}</td><td>{{ formatDate(item.created_at) }}</td><td>{{ formatDate(item.expires_at) }}</td><td class="visit-count">{{ Number(item.used_quota || 0).toLocaleString() }}</td><td class="visit-count" :class="{ 'quota-empty': Number(item.remaining_quota || 0) === 0 }">{{ Number(item.remaining_quota || 0).toLocaleString() }}</td><td><span class="table-status" :class="{ disabled: item.status !== 'active' }">{{ item.status === 'active' ? '正常' : '停用' }}</span></td><td class="table-actions"><button type="button" @click="editBusinessGroup(item)">编辑</button></td></tr></tbody></table>
            <table v-else class="data-table"><thead><tr><th>序号</th><th>用户名</th><th>登录手机号</th><th>所属业务组</th><th>账号类型</th><th>添加时间</th><th>到期时间</th><th v-if="activePage === 'expiring'">剩余有效期</th><th>状态</th><th v-if="activePage === 'admins' ? isSuper : (activePage === 'promoters' && canManagePromoters)">操作</th></tr></thead><tbody><tr v-for="(item, i) in activePage === 'expiring' ? expiring : users" :key="item.id"><td>{{ i + 1 }}</td><td><b>{{ item.name }}</b></td><td>{{ item.phone }}</td><td>{{ item.business_group_name || '平台管理' }}</td><td>{{ roleLabels[item.role] }}</td><td>{{ formatDate(item.created_at) }}</td><td>{{ formatDate(item.expires_at) }}</td><td v-if="activePage === 'expiring'"><span class="expiry-days">{{ item.remaining_days }} 天</span></td><td><span class="table-status" :class="{ disabled: item.status !== 'active' }">{{ item.status === 'active' ? '正常' : '暂停使用' }}</span></td><td v-if="activePage === 'admins' ? isSuper : (activePage === 'promoters' && canManagePromoters)" class="table-actions"><button type="button" @click="editUser(item)">编辑</button><button type="button" @click="changeUserStatus(item)">{{ item.status === 'active' ? '暂停' : '恢复' }}</button><button type="button" @click="removeUser(item)">删除</button></td></tr></tbody></table>
          </div>
        </template>

        <template v-else-if="['add-promoter', 'add-admin'].includes(activePage)">
          <div class="form-card account-form"><div class="form-section-title"><span>＋</span><div><h3>{{ activePage === 'add-admin' ? '添加管理员账号' : '添加推广员' }}</h3><p>登录账号使用手机号，创建后即可登录系统。</p></div></div><div class="form-grid two"><label v-if="activePage === 'add-promoter'"><span>选择业务组</span><el-select v-model="userForm.businessGroupId"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label><label><span>用户名</span><el-input v-model="userForm.name" placeholder="请输入姓名" /></label><label><span>登录账号</span><el-input v-model="userForm.phone" placeholder="请输入登录手机号" /></label><label><span>登录密码</span><el-input v-model="userForm.password" type="password" show-password placeholder="设置初始密码" /></label><label><span>账号到期日期</span><el-date-picker v-model="userForm.expiresAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="选择到期时间" /></label></div><div class="form-footer"><button type="button" @click="saveUser(activePage === 'add-admin' ? 'system_admin' : 'general_user')">保存账号</button></div></div>
        </template>

        <template v-else-if="activePage === 'add-business-group'">
          <div class="form-card account-form"><div class="form-section-title"><span>＋</span><div><h3>添加业务组</h3><p>创建业务组时同步开通该组管理员账号。</p></div></div><div class="form-grid two"><label><span>业务组名称</span><el-input v-model="groupForm.name" placeholder="请输入业务组名称" /></label><label><span>管理员用户名</span><el-input v-model="groupForm.managerName" placeholder="请输入管理员姓名" /></label><label><span>管理员登录手机</span><el-input v-model="groupForm.managerPhone" placeholder="请输入手机号" /></label><label><span>管理员密码</span><el-input v-model="groupForm.password" type="password" show-password placeholder="设置初始密码" /></label><label><span>账号到期日期</span><el-date-picker v-model="groupForm.expiresAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="选择到期时间" /></label></div><div class="form-footer"><button type="button" @click="saveBusinessGroup">保存业务组</button></div></div>
        </template>

        <template v-else-if="activePage === 'customer-link'">
          <div class="domain-pool-card">
            <div class="link-config-heading">
              <span class="config-icon">⌁</span>
              <div><h2>客户域名池</h2><p>集中维护客户访问域名；Suolink 新推广链接会在已启用供应商域名之间均衡轮换。</p></div>
              <button class="pool-add-button" type="button" @click="openAddDomain">＋ 添加域名</button>
            </div>
            <div class="pool-summary">
              <article><span>域名总数</span><b>{{ domains.length }}</b></article>
              <article><span>启用域名</span><b>{{ domains.filter(item => item.is_enabled).length }}</b></article>
              <article><span>已分配链接</span><b>{{ domains.reduce((total, item) => total + Number(item.link_count || 0), 0) }}</b></article>
            </div>
            <section
              v-if="cardDomainConfig && cardDomainConfig.status !== 'ok'"
              class="domain-config-alert"
              :class="{ invalid: cardDomainConfig.status === 'invalid' }"
            >
              <strong>{{ cardDomainConfig.status === 'mismatch' ? '卡片域名配置不一致' : '卡片域名尚未就绪' }}</strong>
              <p>{{ cardDomainConfig.message }}</p>
              <p>{{ cardDomainConfig.repair }}</p>
            </section>
            <section v-else-if="cardDomainConfig" class="domain-config-ok">
              {{ cardDomainConfig.message }}
            </section>
            <section class="suolink-config-card">
              <div class="suolink-config-heading">
                <div><h3>Suolink 第三方缩链</h3><p>启用并配置后，管理台生成推广链接时可选择 Suolink。</p></div>
                <el-switch v-model="suolinkForm.enabled" active-text="启用" inactive-text="停用" />
              </div>
              <div class="suolink-config-fields">
                <label><span>API Key</span><el-input v-model="suolinkForm.apiKey" type="password" show-password autocomplete="new-password" :placeholder="suolinkForm.apiKeyConfigured ? `已配置 ${suolinkForm.apiKeyMasked}，留空则不修改` : '请输入 Suolink API Key'" /></label>
                <label><span>Suolink Domain</span><el-input v-model="suolinkForm.domain" placeholder="已绑定到当前 API Key 的域名，无需填写路径" /></label>
                <el-button type="primary" :loading="suolinkSaving" @click="saveSuolinkConfig">保存缩链设置</el-button>
              </div>
              <div class="suolink-domain-options"><span>生成域名快捷填入：</span><button v-for="domain in suolinkSharedDomains" :key="domain" type="button" :class="{ active: suolinkForm.domain === domain }" @click="suolinkForm.domain = domain">{{ domain }}</button></div>
              <p class="suolink-config-tip">保存后的 Suolink Domain 会作为并列时的首选域名；域名池中其他已启用且绑定当前 API Key 的 Suolink 域名也会参与轮换。API Key 将加密保存且不会回显明文。</p>
            </section>
            <section class="suolink-config-card wechat-config-card">
              <div class="suolink-config-heading">
                <div><h3>微信链接卡片（Open Graph）</h3><p>无需公众号、AppID、AppSecret 或微信 JS-SDK；短链首屏由服务端直接返回标题、简介和 HTTPS 封面。</p></div>
              </div>
              <div class="wechat-config-guide">
                <strong>工作方式</strong>
                <ol>
                  <li>每条推广链接独立保存卡片标题、简介和封面。</li>
                  <li>微信与普通浏览器读取相同的完整 Open Graph HTML。</li>
                  <li>浏览器随后解码 Base64 目标并直接进入播放页，无需再次点击“继续播放”。</li>
                </ol>
                <p>Open Graph 控制服务端返回的标题、描述和封面；微信普通聊天卡片通常只显示标题、URL/域名和缩略图，不一定显示描述。具体布局、是否展开及缓存时长由微信客户端决定，并非后端错误。</p>
                <p>二维码只负责进入正确的推广入口。扫码进入播放器后，地址应恢复为同源 /s 或 /card；若仍停留在 /play，二维码本身无法修复二次分享地址。</p>
              </div>
            </section>
            <section class="delivery-readiness-card">
              <div><h3>投放链路检测</h3><p>检测缩链、卡片页、服务端 Open Graph 元数据和 HTTPS 是否具备验收条件。</p></div>
              <el-button :loading="readinessLoading" @click="checkDeliveryReadiness">一键检测</el-button>
              <div v-if="readiness" class="readiness-results">
                <span v-for="item in readinessItems" :key="item.key" :class="{ passed: item.passed }">{{ item.passed ? '✓' : '!' }} {{ item.label }}</span>
              </div>
            </section>
            <div class="domain-pool-table-wrap">
              <table class="data-table domain-pool-table">
                <thead><tr><th>域名</th><th>平台</th><th>备注</th><th>已分配链接</th><th>状态</th><th>角色</th><th>操作</th></tr></thead>
                <tbody><tr v-for="item in domains" :key="item.id">
                  <td><code>{{ item.domain }}</code></td><td><span :class="item.platform === 'suolink' ? 'platform-tag suolink' : 'platform-tag'">{{ item.platform === 'suolink' ? 'Suolink' : '自建 self' }}</span></td><td>{{ item.remark || '-' }}</td><td>{{ item.link_count || 0 }}</td>
                  <td><span class="table-status" :class="{ disabled: !item.is_enabled }">{{ item.is_enabled ? '已启用' : '已停用' }}</span></td>
                  <td><span v-if="item.is_primary" class="primary-domain-tag">主域名</span><span v-else>池内域名</span></td>
                  <td class="table-actions"><button type="button" @click="openEditDomain(item)">编辑</button><button v-if="!item.is_primary && item.is_enabled" type="button" @click="setPrimaryDomain(item)">设为主域名</button><button v-if="!item.is_primary" type="button" @click="toggleDomain(item)">{{ item.is_enabled ? '停用' : '启用' }}</button><button v-if="!item.is_primary" type="button" class="danger" @click="removeDomain(item)">删除</button></td>
                </tr></tbody>
              </table>
              <el-empty v-if="!domains.length" description="域名池为空，请先添加域名" />
            </div>
            <div class="link-config-note"><b>生成规则</b><p>Suolink 新推广链接会在已启用供应商域名中优先选择已分配链接数较少的域名；生成失败时会继续尝试其他候选。自建短链使用与卡片配置一致的 self 域名。切换主域名或 Suolink 配置只影响之后生成的链接，历史链接保持原地址。</p><p>未设置 PUBLIC_CARD_BASE_URL 时使用启用的 self 主域名；设置后必须在域名池中启用同名 self 域名。主域名同时作为播放地址兜底。微信正式投放建议使用已备案并配置 HTTPS 的域名。</p></div>
          </div>
        </template>

        <template v-else-if="activePage === 'visit-quotas'">
          <div class="visit-quota-page">
            <section class="visit-quota-heading">
              <div>
                <h2>访问量管理</h2>
                <p>{{ visitQuotaData.period || '-' }} 自然月；新周期按有效推广员数 × 平台默认额度初始化，当前月可按业务组单独修改。</p>
              </div>
              <div class="visit-quota-period">当前周期 <b>{{ visitQuotaData.period || '-' }}</b></div>
            </section>
            <section class="visit-quota-settings">
              <div>
                <h3>平台默认：每位有效推广员月度额度（下月生效）</h3>
                <p>只用于下个自然月初始化各业务组基础额度，不会修改当前月；当前月请在下表逐组保存。</p>
              </div>
              <div class="visit-quota-setting-action">
                <el-input-number v-model="visitQuotaPerEmployee" :min="1" :max="1000000" :step="100" controls-position="right" />
                <el-button type="primary" @click="saveVisitQuotaPerEmployee">保存设置</el-button>
              </div>
            </section>
            <div v-if="visitQuotaData.groups.length" class="visit-quota-list">
              <article v-for="group in visitQuotaData.groups" :key="group.businessGroupId" class="visit-quota-row">
                <div class="visit-quota-group">
                  <b>{{ group.businessGroupName }}</b>
                  <span>{{ group.effectiveEmployees }} 位有效推广员</span>
                </div>
                <div class="visit-quota-metric"><span>基础额度</span><b>{{ group.baseQuota.toLocaleString() }}</b></div>
                <div class="visit-quota-metric"><span>追加额度</span><b>{{ group.extraQuota.toLocaleString() }}</b></div>
                <div class="visit-quota-metric"><span>总额度</span><b>{{ (group.baseQuota + group.extraQuota).toLocaleString() }}</b></div>
                <div class="visit-quota-metric"><span>已使用</span><b>{{ group.usedQuota.toLocaleString() }}</b></div>
                <div class="visit-quota-metric"><span>剩余</span><b :class="{ 'quota-empty': group.remainingQuota === 0 }">{{ group.remainingQuota.toLocaleString() }}</b></div>
                <el-button type="primary" plain @click="openVisitQuotaEditor(group)">调整额度</el-button>
              </article>
            </div>
            <el-empty v-else description="暂无业务组" />
            <p class="visit-quota-note">访问超出本月总额度时会被拒绝，点击数和访问日志不会写入；自然月切换后会自动创建新周期并重新计算基础额度。</p>
          </div>
        </template>
      </main>
    </div>

    <el-dialog v-model="visitQuotaEditVisible" title="调整业务组访问额度" width="560px" destroy-on-close>
      <template v-if="visitQuotaEditGroup">
        <p class="visit-quota-dialog-group">{{ visitQuotaEditGroup.businessGroupName }}</p>
        <div class="visit-quota-dialog-grid">
          <label>
            <span>本月基础额度</span>
            <el-input-number v-model="visitQuotaBases[visitQuotaEditGroup.businessGroupId]" :min="1" :max="100000000" :step="100" controls-position="right" />
            <el-button type="primary" plain @click="updateVisitQuotaBase(visitQuotaEditGroup)">保存基础额度</el-button>
          </label>
          <label>
            <span>追加本月额外额度</span>
            <el-input-number v-model="visitQuotaAdditions[visitQuotaEditGroup.businessGroupId]" :min="1" :max="100000000" :step="100" controls-position="right" placeholder="次数" />
            <el-button type="primary" plain @click="addVisitQuota(visitQuotaEditGroup)">追加额度</el-button>
          </label>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="userEditVisible" title="编辑账号资料" width="620px" destroy-on-close>
      <div class="dialog-form-grid">
        <label><span>用户名</span><el-input v-model="editUserForm.name" placeholder="请输入姓名" /></label>
        <label><span>登录手机号</span><el-input v-model="editUserForm.phone" placeholder="请输入登录手机号" /></label>
        <label v-if="editUserForm.role === 'general_user' && isPlatformAdmin"><span>所属业务组</span><el-select v-model="editUserForm.businessGroupId"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label>
        <label><span>账号状态</span><el-select v-model="editUserForm.status"><el-option label="正常" value="active" /><el-option label="暂停使用" value="disabled" /></el-select></label>
        <label><span>账号到期时间</span><el-date-picker v-model="editUserForm.expiresAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="长期有效" /></label>
        <label><span>重置密码</span><el-input v-model="editUserForm.password" type="password" show-password placeholder="留空则不修改密码" /></label>
      </div>
      <template #footer><el-button @click="userEditVisible = false">取消</el-button><el-button type="primary" @click="saveEditedUser">保存修改</el-button></template>
    </el-dialog>

    <el-dialog v-model="materialEditVisible" title="编辑素材" width="680px" destroy-on-close>
      <div class="dialog-form-grid material-dialog-form">
        <label><span>素材名称</span><el-input v-model="editMaterialForm.title" maxlength="255" show-word-limit placeholder="请输入素材名称" /></label>
        <label class="full-width"><span>素材简介</span><el-input v-model="editMaterialForm.description" type="textarea" :rows="4" maxlength="2000" show-word-limit placeholder="请输入素材简介" /></label>
        <label v-if="isPlatformAdmin"><span>所属业务组</span><el-select v-model="editMaterialForm.businessGroupId" clearable placeholder="请选择业务组" @change="handleEditMaterialBusinessGroupChange"><el-option v-for="g in businessGroups" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label>
        <label><span>所属素材组</span><el-select v-model="editMaterialForm.materialGroupId" clearable placeholder="请选择素材组"><el-option v-for="g in materialGroups.filter(x => !editMaterialForm.businessGroupId || String(x.business_group_id) === String(editMaterialForm.businessGroupId))" :key="g.id" :label="g.name" :value="String(g.id)" /></el-select></label>
      </div>
      <template #footer><el-button @click="materialEditVisible = false">取消</el-button><el-button type="primary" @click="saveEditedMaterial">保存修改</el-button></template>
    </el-dialog>

    <el-dialog v-model="shareCardVisible" title="微信卡片设置" width="min(760px, 92vw)" destroy-on-close @closed="resetShareCardDialog">
      <div class="share-card-dialog">
        <div class="share-card-fields">
          <div class="readonly-card-mode"><span>微信卡片模式：</span><b>{{ shareCardForm.wechatCardMode === 'text_description' ? '纯文字简介实验' : '标准图文卡片' }}</b><small>已生成短码不能切换模式；如需对比，请生成全新短链。</small></div>
          <div v-if="shareCardForm.wechatCardMode === 'standard'" class="share-cover-field"><span>封面图</span><div class="share-cover-editor"><div class="share-cover-preview"><img :src="shareCardForm.coverUrl" alt="微信卡片封面" /></div><label class="share-cover-button"><input type="file" accept="image/jpeg,image/png,image/webp" @change="selectShareCardCover" />{{ shareCardForm.coverFile ? '重新选择' : '更换图片' }}</label></div><small>支持 JPG、PNG、WebP，最大 5MB；建议使用 1:1 正方形图片。</small></div>
          <label><span>标题</span><el-input v-model="shareCardForm.title" maxlength="80" show-word-limit placeholder="请输入卡片标题" /></label>
          <label><span>描述</span><el-input v-model="shareCardForm.description" type="textarea" :rows="3" maxlength="120" show-word-limit placeholder="请输入卡片描述" /></label>
          <p v-if="shareCardForm.wechatCardMode === 'text_description'">该模式不会输出任何封面或图片元数据，只提供标题、可见简介及标准结构化简介字段。微信展示结果由客户端决定，系统不能保证一定显示简介。</p>
          <p v-else>自建短链会直接返回标题、简介和封面供微信抓取；若客户端缓存导致粘贴后未展开，请在微信内打开链接，再点击右上角“发送给朋友”。</p>
        </div>
        <div class="wechat-card-preview">
          <span class="wechat-preview-label">效果预览</span>
          <article :class="{ 'text-description-preview': shareCardForm.wechatCardMode === 'text_description' }">
            <div><b>{{ shareCardForm.title || '卡片标题' }}</b><p>{{ shareCardForm.description || '卡片描述' }}</p></div>
            <img v-if="shareCardForm.wechatCardMode === 'standard'" :src="shareCardForm.coverUrl" alt="卡片缩略图" />
          </article>
          <small>{{ shareCardForm.link }}</small>
        </div>
      </div>
      <template #footer><el-button @click="shareCardVisible = false">取消</el-button><el-button type="primary" :loading="shareCardSaving" @click="saveShareCard">{{ canManageMaterials ? '保存并复制卡片链接' : '复制卡片链接' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="wechatShareVisible" title="微信分享" width="min(620px, 92vw)" destroy-on-close @closed="resetWechatShareDialog">
      <div class="wechat-share-dialog">
        <div class="wechat-share-details">
          <h3>{{ wechatShareForm.title }}</h3>
          <img v-if="wechatShareForm.wechatCardMode === 'standard'" class="wechat-share-cover" :src="wechatShareForm.coverUrl" alt="卡片封面" />
          <p v-else class="experiment-share-note">纯文字简介实验不会输出封面；二维码仍编码原始实验短链。</p>
          <label><span>原始推广短网址</span><code>{{ wechatShareForm.link }}</code></label>
          <el-button type="primary" @click="copyWechatShareLink">复制链接</el-button>
        </div>
        <div class="wechat-share-qr">
          <img v-if="wechatShareForm.qrDataUrl" :src="wechatShareForm.qrDataUrl" :data-qr-value="wechatShareForm.link" width="320" height="320" alt="微信分享二维码" />
          <p>请使用微信扫描二维码，页面打开并进入播放器后，点击右上角分享给好友或群聊。</p>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-if="TEXT_DESCRIPTION_EXPERIMENT_ENABLED" v-model="abResultVisible" title="微信卡片 A/B 测试链接" width="min(680px, 92vw)" destroy-on-close>
      <div class="ab-result-dialog">
        <p>以下两条都是本次新生成的自建短码，标题和简介相同。A 保留标准图片字段，B 删除全部图片信号并增加结构化简介字段。</p>
        <label><span>A · 标准图文</span><code>{{ abResult.standard }}</code></label>
        <label><span>B · 纯文字实验</span><code>{{ abResult.textDescription }}</code></label>
        <p class="experiment-warning">这是微信客户端行为实验，不保证一定展示独立简介。请在同一个新聊天中依次发送 A、B，并记录微信版本、系统版本和截图。</p>
      </div>
      <template #footer><el-button @click="abResultVisible = false">关闭</el-button><el-button type="primary" @click="copyAbLinks">复制两个链接</el-button></template>
    </el-dialog>

    <el-dialog v-model="groupEditVisible" title="编辑业务组资料" width="680px" destroy-on-close>
      <div class="dialog-form-grid">
        <label><span>业务组名称</span><el-input v-model="editGroupForm.name" placeholder="请输入业务组名称" /></label>
        <label><span>管理员用户名</span><el-input v-model="editGroupForm.managerName" placeholder="请输入管理员姓名" /></label>
        <label><span>管理员登录手机</span><el-input v-model="editGroupForm.managerPhone" placeholder="请输入手机号" /></label>
        <label><span>业务组状态</span><el-select v-model="editGroupForm.status"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select></label>
        <label><span>到期时间</span><el-date-picker v-model="editGroupForm.expiresAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="长期有效" /></label>
        <label><span>重置管理员密码</span><el-input v-model="editGroupForm.password" type="password" show-password placeholder="留空则不修改密码" /></label>
      </div>
      <template #footer><el-button @click="groupEditVisible = false">取消</el-button><el-button type="primary" @click="saveEditedBusinessGroup">保存修改</el-button></template>
    </el-dialog>

    <el-dialog v-model="domainEditVisible" :title="domainForm.id ? '编辑域名' : '添加域名到域名池'" width="620px" destroy-on-close>
      <div class="dialog-form-grid domain-dialog-form">
        <label><span>完整域名地址</span><el-input v-model="domainForm.domain" placeholder="例如：https://video.customer.com" /></label>
        <label><span>备注</span><el-input v-model="domainForm.remark" placeholder="例如：客户主站域名" /></label>
        <label><span>加入后状态</span><el-switch v-model="domainForm.isEnabled" active-text="启用" inactive-text="停用" /></label>
        <label v-if="!domainForm.id"><span>域名角色</span><el-switch v-model="domainForm.isPrimary" active-text="设为主域名" inactive-text="普通池内域名" /></label>
      </div>
      <p class="domain-dialog-tip">仅填写根地址，不要包含 /play、查询参数或具体视频路径。</p>
      <template #footer><el-button @click="domainEditVisible = false">取消</el-button><el-button type="primary" @click="saveDomain">保存域名</el-button></template>
    </el-dialog>
  </div>
</template>
