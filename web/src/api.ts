import axios from "axios";

export const api = axios.create({
  baseURL: "/k9m4x7q2/api",
  timeout: 60000,
});

const TOKEN_KEY = "admin_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// 请求带上 bearer token
api.interceptors.request.use((config) => {
  const t = getToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// 401 -> 清 token 并回到登录
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      clearToken();
      if (location.hash !== "#/login") location.reload();
    }
    return Promise.reject(err);
  }
);

// 导出 baseURL 用于拼接完整 URL（头像预览等）
export const BASE_URL = api.defaults.baseURL?.replace(/\/api$/, "") || "";

// 相对路径(如 /uploads/xxx.png)拼成完整可访问URL
export function resolveUrl(v?: string) {
  if (!v) return "";
  if (/^https?:\/\//.test(v)) return v;
  return BASE_URL + v;
}

// ---- 登录 ----
export async function login(password: string) {
  const { data } = await api.post("/admin/login", { password });
  if (data.success && data.token) setToken(data.token);
  return data as { success: boolean; token?: string; message?: string };
}
export async function logout() {
  try {
    await api.post("/admin/logout");
  } catch {
    /* 清本地即可 */
  }
  clearToken();
  location.reload();
}

export async function uploadAvatar(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const { data } = await api.post("/upload/avatar", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

export interface LicenseKey {
  id: number;
  keyCode: string;
  name: string;
  nickname: string;
  avatar: string;
  maxDevices: number;
  status: "active" | "disabled";
  expiryDate: string;
  validDays: number;
  licenseType?: "manual" | "trial" | "formal";
  note: string;
  cardId: number | null;
  cardLabel?: string;
  agentId: number | null;
  agentName?: string;
  agentIsTest?: boolean;
  remainingDays?: number | null;
  customerName?: string;
  phone?: string;
  wechat?: string;
  qq?: string;
  contactType?: string;
  contactValue?: string;
  activated?: boolean;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
  deviceCount: number;
}

export interface DeviceItem {
  id: number;
  keyId: number;
  deviceId: string;
  nickname: string;
  avatar: string;
  deviceLabel: string;
  status: "active" | "kicked";
  firstLoginAt: string;
  lastSeenAt: string;
}

export interface TokenSub {
  id: number;
  token: string;
  site: string;
  status: "active" | "invalid" | "disabled";
  deviceCount: number;
  hasCookie: boolean;
  cookieCount: number;
  cookiePulledAt: string;
  cookieXtokenExp: string;
  cookieNick: string;
  cookieVipExp: string;
  createdAt: string;
}

export interface CardItem {
  id: number;
  label: string;
  providerCode: string;
  product: string;
  site: string;
  expiryDate: string;
  status: "active" | "disabled";
  lastCheckedAt: string;
  note: string;
  tokenCount: number;
  cookieReady: number;
  usedDevices: number;
  assignedCount: number;
  tokens: TokenSub[];
  createdAt: string;
  updatedAt: string;
}

export async function fetchKeys(params: {
  current?: number;
  pageSize?: number;
  keyCode?: string;
  name?: string;
  status?: string;
  keyState?: string;
  agentId?: number | string;
  licenseType?: string;
}) {
  const { data } = await api.get("/admin/keys", { params });
  return data;
}

export async function createKey(payload: {
  name?: string;
  nickname?: string;
  avatar?: string;
  maxDevices: number;
  expiryDate?: string;
  validDays?: number;
  note?: string;
  cardId?: number | null;
  agentId?: number | null;
  licenseType?: "manual" | "trial" | "formal";
  customerName?: string;
  phone?: string;
  wechat?: string;
  qq?: string;
  contactType?: string;
  contactValue?: string;
}) {
  const { data } = await api.post("/admin/keys", payload);
  return data;
}

export async function createKeysBatch(payload: {
  count: number;
  nickname?: string;
  avatar?: string;
  maxDevices: number;
  expiryDate?: string;
  validDays?: number;
  cardId?: number | null;
  agentId?: number | null;
  licenseType?: "manual" | "trial" | "formal";
}) {
  const { data } = await api.post("/admin/keys/batch", payload);
  return data as { success: boolean; data?: LicenseKey[]; message?: string };
}

export async function updateKey(id: number, payload: Partial<LicenseKey>) {
  const { data } = await api.put(`/admin/keys/${id}`, payload);
  return data;
}

export async function deleteKey(id: number) {
  const { data } = await api.delete(`/admin/keys/${id}`);
  return data;
}

export async function deleteKeysBatch(ids: number[]) {
  const { data } = await api.post("/admin/keys/batch-delete", { ids });
  return data as { success: boolean; deleted?: number; message?: string };
}

export async function fetchDevices(keyId: number) {
  const { data } = await api.get(`/admin/keys/${keyId}/devices`);
  return data;
}

export async function updateDevice(
  id: number,
  payload: { nickname?: string; avatar?: string; deviceLabel?: string }
) {
  const { data } = await api.put(`/admin/devices/${id}`, payload);
  return data;
}

export async function kickDevice(id: number) {
  const { data } = await api.post(`/admin/devices/${id}/kick`);
  return data;
}

export async function deleteDevice(id: number) {
  const { data } = await api.delete(`/admin/devices/${id}`);
  return data;
}

export async function fetchStats() {
  const { data } = await api.get("/admin/stats");
  return data;
}

export interface AgentSlice {
  agentId: number;
  agentName: string;
  count: number;
}

export interface ActivationPoint {
  date: string;
  count: number;
  agents: AgentSlice[];
}

export async function fetchActivationStats(from: string, to: string) {
  const { data } = await api.get("/admin/stats/activations", { params: { from, to } });
  return data as { success: boolean; data: ActivationPoint[]; from: string; to: string };
}

export async function fetchPendingByAgent() {
  const { data } = await api.get("/admin/stats/pending");
  return data as { success: boolean; data: AgentSlice[]; total: number };
}

// ---- 代理库 ----
export interface AgentItem {
  id: number;
  name: string;
  capacity: number;
  used: number;
  isTest: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchAgents() {
  const { data } = await api.get("/admin/agents");
  return data as { success: boolean; data: AgentItem[] };
}
export async function createAgent(payload: { name: string; capacity: number; note?: string; isTest?: boolean }) {
  const { data } = await api.post("/admin/agents", payload);
  return data as { success: boolean; data?: AgentItem; message?: string };
}
export async function updateAgent(id: number, payload: { name?: string; capacity?: number; note?: string; isTest?: boolean }) {
  const { data } = await api.put(`/admin/agents/${id}`, payload);
  return data as { success: boolean; data?: AgentItem; message?: string };
}
export async function deleteAgent(id: number) {
  const { data } = await api.delete(`/admin/agents/${id}`);
  return data;
}

// ---- 卡密池 ----
export async function fetchCards() {
  const { data } = await api.get("/admin/cards");
  return data as { success: boolean; data: CardItem[] };
}
export async function createCard(payload: { providerCode: string; label?: string; note?: string }) {
  const { data } = await api.post("/admin/cards", payload);
  return data;
}
export async function mintToken(cardId: number) {
  const { data } = await api.post(`/admin/cards/${cardId}/mint`);
  return data;
}
export async function refreshCard(cardId: number) {
  const { data } = await api.post(`/admin/cards/${cardId}/refresh`);
  return data;
}
export async function updateCard(id: number, payload: { label?: string; note?: string; status?: string }) {
  const { data } = await api.put(`/admin/cards/${id}`, payload);
  return data;
}
export async function deleteCard(id: number) {
  const { data } = await api.delete(`/admin/cards/${id}`);
  return data;
}
export async function deleteToken(id: number) {
  const { data } = await api.delete(`/admin/tokens/${id}`);
  return data;
}
export async function pullTokenCookie(id: number) {
  const { data } = await api.post(`/admin/tokens/${id}/pull-cookie`);
  return data as { success: boolean; data?: TokenSub; message?: string };
}
export async function pullCardCookie(cardId: number) {
  const { data } = await api.post(`/admin/cards/${cardId}/pull-cookie`);
  return data as { success: boolean; data?: CardItem; message?: string };
}

export interface LoginLog {
  id: number;
  keyId: number;
  keyCode: string;
  keyName: string;
  deviceId: string;
  result: string;
  ip: string;
  createdAt: string;
}

export async function fetchLogs(params: {
  current?: number;
  pageSize?: number;
  keyCode?: string;
  deviceId?: string;
  result?: string;
}) {
  const { data } = await api.get("/admin/logs", { params });
  return data;
}

export interface AdminSettings {
  defaultAvatar: string;
  defaultCardId: number | null;
  vipExpiryEnabled: boolean;
  vipExpiryDate: string;
  mailEnabled: boolean;
  mailHost: string;
  mailPort: number;
  mailUser: string;
  mailTo: string;
  mailPassSet: boolean;
  feishuEnabled: boolean;
  feishuWebhook: string;
  dingtalkEnabled: boolean;
  dingtalkWebhook: string;
  dingtalkSecret: string;
  notifyActivation: boolean;
  notifyMars: boolean;
  notifyYidian: boolean;
  reportEnabled: boolean;
  reportTime: string;
  upstreamMode: "mars" | "legacy";
  marsCode: string;
  marsReady: boolean;
  marsSite: string;
  marsExpiry: string;
  marsBd: string;
  marsCookieCount: number;
  marsXtokenExp: string;
  marsPulledAt: string;
}

export async function fetchSettings() {
  const { data } = await api.get("/admin/settings");
  return data as { success: boolean; data: AdminSettings };
}

export async function updateSettings(payload: {
  defaultAvatar?: string;
  defaultCardId?: number | null;
  vipExpiryEnabled?: boolean;
  vipExpiryDate?: string;
  mailEnabled?: boolean;
  mailHost?: string;
  mailPort?: number;
  mailUser?: string;
  mailPass?: string;
  mailTo?: string;
  feishuEnabled?: boolean;
  feishuWebhook?: string;
  dingtalkEnabled?: boolean;
  dingtalkWebhook?: string;
  dingtalkSecret?: string;
  notifyActivation?: boolean;
  notifyMars?: boolean;
  notifyYidian?: boolean;
  reportEnabled?: boolean;
  reportTime?: string;
  newPassword?: string;
  upstreamMode?: "mars" | "legacy";
  marsCode?: string;
}) {
  const { data } = await api.put("/admin/settings", payload);
  return data;
}

export async function testMarsCode(marsCode: string) {
  const { data } = await api.post("/admin/settings/test-mars", { marsCode });
  return data as { success: boolean; data?: { code: string; site: string; expiryDate: string; xtokenExp: string; cookieCount: number }; message?: string };
}

export async function switchMarsCode(marsCode: string) {
  const { data } = await api.post("/admin/settings/switch-mars", { marsCode });
  return data as { success: boolean; data?: AdminSettings & { switched: boolean }; message?: string };
}

export async function sendTestMail() {
  const { data } = await api.post("/admin/settings/test-mail");
  return data as { success: boolean; message?: string };
}

export async function sendTestFeishu() {
  const { data } = await api.post("/admin/settings/test-feishu");
  return data as { success: boolean; message?: string };
}

// ---- 插件库 ----
export type PluginPlatform = "pc" | "android" | "ios" | "other";

export interface PluginFile {
  id: number;
  name: string;
  slug: string;
  originalName: string;
  ext: string;
  mime: string;
  size: number;
  platform: PluginPlatform;
  downloadCount: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchPlugins() {
  const { data } = await api.get("/admin/plugins");
  return data as { success: boolean; data: PluginFile[] };
}

export async function uploadPlugin(payload: {
  file: File;
  name?: string;
  platform?: PluginPlatform;
  note?: string;
}) {
  const fd = new FormData();
  fd.append("file", payload.file);
  if (payload.name) fd.append("name", payload.name);
  if (payload.platform) fd.append("platform", payload.platform);
  if (payload.note) fd.append("note", payload.note);
  const { data } = await api.post("/upload/plugin", fd, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120000,
  });
  return data as { success: boolean; data?: PluginFile; message?: string };
}

export async function updatePlugin(
  id: number,
  payload: { name?: string; platform?: PluginPlatform; note?: string }
) {
  const { data } = await api.put(`/admin/plugins/${id}`, payload);
  return data;
}

export async function deletePlugin(id: number) {
  const { data } = await api.delete(`/admin/plugins/${id}`);
  return data;
}

// 公开下载链接: zip 用短链 /dl/<slug>; .xpi/.crx 一键安装需要 URL 以真实扩展名结尾
export function pluginDownloadUrl(p: PluginFile) {
  const ext = String(p.ext || "").toLowerCase();
  if (ext === ".xpi" || ext === ".crx") {
    const name = p.originalName || `plugin${p.ext || ""}`;
    return `${location.origin}/dl/${p.slug}/${encodeURIComponent(name)}`;
  }
  return `${location.origin}/dl/${p.slug}`;
}


// ---- 活动看板 / 日志中心 / 插件推送 ----
export interface ActivityOverview {
  onlineDevices: number; onlineUsers: number; onlineExact: number;
  todayUsers: number; todayDevices: number; boundDevices: number; todayActivated: number; todayProblems: number;
  trend: { day: string; users: number; devices: number }[];
  platforms: { platform: string; c: number }[];
  versions: { version: string; c: number }[];
  guard: any; onlineWindowMin: number; note: string;
}
export async function fetchActivityOverview() {
  const { data } = await api.get("/admin/activity/overview");
  return data as { success: boolean; data: ActivityOverview };
}
export interface DeviceState {
  id: number; keyId: number; keyName: string; keyCode: string; deviceLabel: string;
  state: "online" | "today" | "offline" | "kicked" | "expired";
  lastActiveAt: string; ip: string; platform: string; version: string; exact: boolean; firstLoginAt: string;
}
export async function fetchDeviceStates(params: { state?: string; q?: string }) {
  const { data } = await api.get("/admin/activity/devices", { params });
  return data as { success: boolean; data: DeviceState[] };
}
export interface ActivityLog {
  id: number; createdAt: string; category: string; categoryLabel: string; event: string; eventLabel: string;
  keyId: number | null; keyName: string; keyCode: string; deviceLabel: string; deviceId: string;
  platform: string; version: string; ip: string; ok: boolean; estimated: boolean; detail: string;
}
export async function fetchActivityLogs(params: Record<string, any>) {
  const { data } = await api.get("/admin/activity/logs", { params });
  return data as {
    success: boolean; data: ActivityLog[]; total: number; page: number; pageSize: number;
    todaySummary: { category: string; c: number }[];
    events: { value: string; category: string; label: string }[];
  };
}
export async function exportActivityLogs(params: Record<string, any>) {
  const res = await api.get("/admin/activity/logs", { params: { ...params, export: 1 }, responseType: "blob", timeout: 120000 });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `日志-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export interface PluginRelease {
  plugin_id: number; version: string; changelog: string; status: "draft" | "pushed" | "withdrawn";
  force: number; pushed_at: string;
}
export async function fetchPluginReleases() {
  const { data } = await api.get("/admin/plugin-releases");
  return data as { success: boolean; data: PluginRelease[]; versionUsage: { version: string; platform: string; c: number }[] };
}
export async function savePluginRelease(id: number, payload: { version?: string; changelog?: string; force?: boolean }) {
  const { data } = await api.put(`/admin/plugin-releases/${id}`, payload);
  return data as { success: boolean; message?: string };
}
export async function pushPluginRelease(id: number) {
  const { data } = await api.post(`/admin/plugin-releases/${id}/push`);
  return data as { success: boolean; message?: string };
}
export async function withdrawPluginRelease(id: number) {
  const { data } = await api.post(`/admin/plugin-releases/${id}/withdraw`);
  return data as { success: boolean; message?: string };
}

export async function sendTestDingtalk() {
  const { data } = await api.post("/admin/settings/test-dingtalk");
  return data as { success: boolean; message?: string };
}
export async function sendDailyReport() {
  const { data } = await api.post("/admin/report/send", {}, { timeout: 120000 });
  return data as { success: boolean; message?: string; data?: { url: string } };
}

export interface KeyInfo {
  id: number; name: string; note: string; code: string; status: string; expiryDate: string;
  maxDevices: number; activeDevices: number; totalDevices: number; agentName: string; cardLabel: string;
  activatedAt: string; createdAt: string;
}
export async function fetchKeyInfo(id: number) {
  const { data } = await api.get(`/admin/key-info/${id}`);
  return data as { success: boolean; data?: KeyInfo; message?: string };
}
