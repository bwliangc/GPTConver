const $ = (id) => document.getElementById(id);
const input = $('input');
const output = $('output');
const copyOutput = $('copyOutput');
const status = $('status');
const leftType = $('leftType');
const rightType = $('rightType');
const swapDirection = $('swapDirection');
const clearInput = $('clearInput');
const files = $('files');

let downloadedName = 'converted.json';
let lastResult = null;
let convertTimer = null;

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function targetType() {
  return rightType.value || 'sub2';
}

function sourceType() {
  return leftType.value || 'auto';
}

function syncDirectionUI() {
  // selects already represent the UI state
}

function pretty(v) {
  return JSON.stringify(v, null, 2);
}

function toIso(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function secondsUntil(v) {
  const iso = toIso(v);
  if (!iso) return undefined;
  return String(Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000)));
}

function emailKey(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function first(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function strip(v) {
  if (Array.isArray(v)) return v.map(strip).filter((x) => x !== undefined);
  if (isObj(v)) {
    const ent = Object.entries(v)
      .map(([k, val]) => [k, strip(val)])
      .filter(([, val]) => val !== undefined);
    return ent.length ? Object.fromEntries(ent) : undefined;
  }
  if (v === '' || v === null || v === undefined) return undefined;
  return v;
}

function parseJwtPayload(token) {
  if (typeof token !== 'string' || !token.trim()) return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function makeUnsignedJwt(payload) {
  const header = { alg: 'none', typ: 'JWT' };
  const encode = (obj) =>
    btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${encode(header)}.${encode(payload)}.`;
}

function synthIdToken({ email, accountId, planType, expiresAt, userId }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : now + 60 * 60 * 24 * 30;
  const payload = {
    iat: now,
    exp,
    email,
    'https://api.openai.com/profile': strip({ email, email_verified: Boolean(email) }),
    'https://api.openai.com/auth': strip({
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
      chatgpt_user_id: userId,
      user_id: userId,
    }),
  };
  return makeUnsignedJwt(payload);
}

function detectKind(raw, options = {}) {
  if (!isObj(raw)) return 'unknown';
  if (Array.isArray(raw.accounts)) return 'sub2doc';
  if (raw.platform === 'openai' && raw.type === 'oauth' && raw.credentials) return 'sub2account';
  const forced = options.forced || sourceType();
  if (forced && forced !== 'auto') return forced;
  if (raw.accessToken && raw.providerSpecificData) return '9router';
  if (raw.user?.email || raw.accessToken && raw.sessionToken) return 'session';
  if (raw.access_token && (raw.refresh_token || raw.id_token || raw.type === 'codex')) return 'cpa';
  if (raw.access_token || raw.accessToken) return 'cockpit';
  return 'unknown';
}

function normalizeOne(raw) {
  const kind = detectKind(raw);
  if (kind === 'sub2account') {
    const c = raw.credentials || {};
    const email = first(raw.email, c.email, raw.extra?.email);
    return {
      kind: 'sub2account',
      email,
      accountId: first(c.chatgpt_account_id, c.account_id),
      planType: first(c.plan_type),
      accessToken: first(c.access_token),
      refreshToken: first(c.refresh_token),
      sessionToken: first(c.session_token),
      idToken: first(c.id_token),
      idTokenSynthetic: c.id_token_synthetic === true,
      expiresAt: first(toIso(c.expires_at), toIso(raw.expires_at)),
      lastRefresh: first(toIso(raw.extra?.last_refresh), toIso(raw.last_refresh)),
      userId: first(c.chatgpt_user_id, c.user_id),
    };
  }

  if (kind === 'cpa') {
    const email = first(raw.email);
    return {
      kind: 'cpa',
      email,
      accountId: first(raw.account_id),
      planType: first(raw.plan_type),
      accessToken: first(raw.access_token),
      refreshToken: first(raw.refresh_token),
      sessionToken: first(raw.session_token),
      idToken: first(raw.id_token),
      idTokenSynthetic: raw.id_token_synthetic === true,
      expiresAt: first(toIso(raw.expired), toIso(raw.expires_at)),
      lastRefresh: first(toIso(raw.last_refresh)),
      userId: first(raw.user_id),
    };
  }

  if (kind === 'session') {
    const email = first(raw.user?.email, raw.email, parseJwtPayload(raw.accessToken)?.email);
    const accountId = first(raw.account?.id, raw.accountId, parseJwtPayload(raw.accessToken)?.['https://api.openai.com/auth']?.chatgpt_account_id);
    const planType = first(raw.account?.planType, raw.planType, parseJwtPayload(raw.accessToken)?.['https://api.openai.com/auth']?.chatgpt_plan_type);
    const expiresAt = first(toIso(raw.expires), toIso(raw.expiry), toIso(raw.expiresAt));
    const userId = first(parseJwtPayload(raw.accessToken)?.['https://api.openai.com/auth']?.chatgpt_user_id, parseJwtPayload(raw.accessToken)?.['https://api.openai.com/auth']?.user_id);
    return {
      kind: 'session',
      email,
      accountId,
      planType,
      accessToken: first(raw.accessToken),
      refreshToken: first(raw.refreshToken),
      sessionToken: first(raw.sessionToken),
      idToken: first(raw.idToken),
      idTokenSynthetic: false,
      expiresAt,
      lastRefresh: first(toIso(raw.lastRefresh), toIso(raw.updatedAt)),
      userId,
    };
  }

  if (kind === '9router') {
    const p = raw.providerSpecificData || {};
    const email = first(raw.email, p.email, parseJwtPayload(raw.accessToken)?.email);
    return {
      kind: '9router',
      email,
      accountId: first(p.chatgptAccountId, p.chatgpt_account_id, raw.accountId),
      planType: first(p.chatgptPlanType, p.chatgpt_plan_type, raw.planType),
      accessToken: first(raw.accessToken),
      refreshToken: first(raw.refreshToken),
      sessionToken: first(raw.sessionToken),
      idToken: first(raw.idToken),
      idTokenSynthetic: raw.idTokenSynthetic === true,
      expiresAt: first(toIso(raw.expiresAt), toIso(raw.expired)),
      lastRefresh: first(toIso(raw.lastRefresh)),
      userId: first(p.chatgptUserId, p.chatgpt_user_id),
    };
  }

  if (kind === 'cockpit') {
    const email = first(raw.email, raw.user?.email, parseJwtPayload(raw.accessToken)?.email, parseJwtPayload(raw.access_token)?.email);
    const accessToken = first(raw.access_token, raw.accessToken);
    const idToken = first(raw.id_token, raw.idToken);
    const refreshToken = first(raw.refresh_token, raw.refreshToken);
    const accountId = first(raw.account_id, raw.accountId, parseJwtPayload(accessToken)?.['https://api.openai.com/auth']?.chatgpt_account_id);
    const planType = first(raw.plan_type, raw.planType, parseJwtPayload(accessToken)?.['https://api.openai.com/auth']?.chatgpt_plan_type);
    const expiresAt = first(toIso(raw.expired), toIso(raw.expiresAt), toIso(raw.expires));
    return {
      kind: 'cockpit',
      email,
      accountId,
      planType,
      accessToken,
      refreshToken,
      sessionToken: first(raw.session_token, raw.sessionToken),
      idToken,
      idTokenSynthetic: raw.id_token_synthetic === true || raw.idTokenSynthetic === true,
      expiresAt,
      lastRefresh: first(toIso(raw.last_refresh), toIso(raw.lastRefresh)),
      userId: first(raw.user_id, raw.userId),
    };
  }

  throw new Error('暂不支持该 JSON 结构');
}

function normalizeInput(raw) {
  if (Array.isArray(raw)) return raw.flatMap((item) => normalizeInput(item));
  if (isObj(raw) && Array.isArray(raw.accounts)) return raw.accounts.flatMap((item) => normalizeInput(item));
  return [normalizeOne(raw)];
}

function resolveIdToken(n, { synthesize = false } = {}) {
  const realIdToken = n.idTokenSynthetic ? undefined : first(n.idToken);
  if (realIdToken || !synthesize) return realIdToken;
  return synthIdToken({
    email: n.email,
    accountId: n.accountId,
    planType: n.planType,
    expiresAt: n.expiresAt,
    userId: n.userId,
  });
}

function toCpaRecord(n) {
  const accessToken = first(n.accessToken);
  if (!accessToken) throw new Error('缺少 accessToken/access_token');
  const refreshToken = first(n.refreshToken);
  const idToken = resolveIdToken(n, { synthesize: true });
  const out = strip({
    access_token: accessToken,
    account_id: n.accountId,
    email: n.email,
    expired: n.expiresAt,
    id_token: idToken,
    id_token_synthetic: idToken && idToken !== first(n.idToken),
    last_refresh: n.lastRefresh,
    plan_type: n.planType,
    type: 'codex',
  });
  out.refresh_token = refreshToken || '';
  return out;
}

function toSub2Account(n) {
  const accessToken = first(n.accessToken);
  if (!accessToken) throw new Error('缺少 accessToken/access_token');
  const email = n.email;
  const expiresAt = n.expiresAt;
  const credentials = {
    access_token: accessToken,
    chatgpt_account_id: n.accountId,
    chatgpt_user_id: n.userId,
    email,
    expires_at: expiresAt,
    expires_in: secondsUntil(expiresAt),
    plan_type: n.planType,
  };
  const refreshToken = first(n.refreshToken);
  if (refreshToken) credentials.refresh_token = refreshToken;
  const idToken = resolveIdToken(n, { synthesize: false });
  if (idToken) credentials.id_token = idToken;
  return strip({
    name: email || n.accountId || 'converted-account',
    platform: 'openai',
    type: 'oauth',
    concurrency: 10,
    priority: 1,
    credentials,
    extra: {
      email,
      email_key: emailKey(email),
      last_refresh: n.lastRefresh,
      source_kind: n.kind,
    },
  });
}

function toCockpitRecord(n) {
  const accessToken = first(n.accessToken);
  if (!accessToken) throw new Error('缺少 accessToken/access_token');
  const out = {
    access_token: accessToken,
    account_id: n.accountId,
    email: n.email,
    expired: n.expiresAt,
    last_refresh: n.lastRefresh,
    plan_type: n.planType,
    type: 'codex',
  };
  const refreshToken = first(n.refreshToken);
  const idToken = resolveIdToken(n, { synthesize: true });
  if (idToken) out.id_token = idToken;
  if (idToken && idToken !== first(n.idToken)) out.id_token_synthetic = true;
  const stripped = strip(out);
  stripped.refresh_token = refreshToken || '';
  return stripped;
}

function to9routerRecord(n) {
  const accessToken = first(n.accessToken);
  if (!accessToken) throw new Error('缺少 accessToken/access_token');
  const now = new Date().toISOString();
  const out = {
    provider: 'openai',
    authType: 'oauth',
    accessToken,
    sessionToken: first(n.sessionToken),
    expiresAt: n.expiresAt,
    priority: 1,
    isActive: true,
    providerSpecificData: {
      chatgptAccountId: n.accountId,
      chatgptPlanType: n.planType,
      chatgptUserId: n.userId,
      email: n.email,
    },
    createdAt: now,
    updatedAt: now,
  };
  const refreshToken = first(n.refreshToken);
  if (refreshToken) out.refreshToken = refreshToken;
  const idToken = resolveIdToken(n, { synthesize: false });
  if (idToken) out.idToken = idToken;
  if (n.idTokenSynthetic) out.idTokenSynthetic = true;
  return strip(out);
}

function exportValue(normalized) {
  const target = targetType();
  if (target === 'sub2') {
    return {
      exported_at: new Date().toISOString(),
      proxies: [],
      accounts: normalized.map(toSub2Account),
    };
  }
  const map = {
    cpa: toCpaRecord,
    cockpit: toCockpitRecord,
    '9router': to9routerRecord,
  };
  const fn = map[target];
  if (!fn) throw new Error(`暂不支持输出 ${target}`);
  const items = normalized.map(fn);
  return items.length === 1 ? items[0] : items;
}

function clearResult(message = '等待输入') {
  lastResult = null;
  downloadedName = 'converted.json';
  output.textContent = '{}';
  status.textContent = message;
}

function renderSourceText(raw) {
  input.value = pretty(raw);
}

function convertFromText(text) {
  const source = String(text || '').trim();
  if (!source) {
    clearResult('等待输入');
    return;
  }
  const raw = JSON.parse(source);
  const normalized = normalizeInput(raw);
  if (!normalized.length) throw new Error('未识别到可转换的账号数据');
  const result = exportValue(normalized);
  lastResult = result;
  downloadedName = `converted.${targetType()}.json`;
  output.textContent = pretty(result);
  status.textContent = `已转换为 ${targetType()}，共 ${normalized.length} 条`;
}

function convert() {
  try {
    convertFromText(input.value);
  } catch (e) {
    lastResult = null;
    output.textContent = String(e.message || e);
    status.textContent = '转换失败';
  }
}

function scheduleConvert(delay = 250) {
  window.clearTimeout(convertTimer);
  convertTimer = window.setTimeout(convert, delay);
}

function download() {
  if (!lastResult) return;
  const blob = new Blob([pretty(lastResult)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadedName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function legacyCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy failed');
}

async function copyToClipboard() {
  const text = output.textContent || '';
  if (!text || text === '{}') return;
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard api unavailable');
      await navigator.clipboard.writeText(text);
    } catch {
      legacyCopyText(text);
    }
    status.textContent = '已复制到剪贴板';
    window.setTimeout(() => {
      if (status.textContent === '已复制到剪贴板') status.textContent = '等待输入';
    }, 1200);
  } catch {
    status.textContent = '复制失败';
  }
}

function tryParseText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return JSON.parse(t);
}

async function readFile(file) {
  return tryParseText(await file.text());
}

async function importFiles() {
  const list = [...files.files || []];
  if (!list.length) return;
  try {
    const raws = [];
    for (const file of list) raws.push(await readFile(file));
    const raw = raws.length === 1 ? raws[0] : raws;
    renderSourceText(raw);
    const normalized = normalizeInput(raw);
    const result = exportValue(normalized);
    lastResult = result;
    downloadedName = `merged.${targetType()}.json`;
    output.textContent = pretty(result);
    status.textContent = `已导入 ${list.length} 个文件，转换 ${normalized.length} 条`;
  } catch (e) {
    lastResult = null;
    output.textContent = String(e.message || e);
    status.textContent = '导入失败';
  } finally {
    files.value = '';
  }
}

function clearInputValue() {
  input.value = '';
  clearResult('等待输入');
}

$('download').addEventListener('click', download);
copyOutput.addEventListener('click', () => copyToClipboard());
clearInput.addEventListener('click', clearInputValue);
$('pickFiles').addEventListener('click', () => files.click());
leftType.addEventListener('change', () => scheduleConvert(0));
rightType.addEventListener('change', () => scheduleConvert(0));
swapDirection.addEventListener('click', () => {
  const left = leftType.value;
  const right = rightType.value;
  const targetable = new Set(['cpa', 'sub2', 'cockpit', '9router']);
  leftType.value = right || 'auto';
  rightType.value = targetable.has(left) ? left : 'sub2';
  scheduleConvert(0);
});
files.addEventListener('change', importFiles);
input.addEventListener('input', () => scheduleConvert());
input.value = pretty({
  access_token: '...',
  account_id: '...',
  email: 'demo@example.com',
  expired: '2026-06-01T13:23:41.000Z',
  id_token: '...',
  last_refresh: '2026-05-22T15:53:44.442Z',
  refresh_token: '...',
  type: 'codex',
});
syncDirectionUI();
convert();
