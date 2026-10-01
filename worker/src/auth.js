// JWT（HS256）与相册密码哈希工具，基于 Web Crypto API，无外部依赖

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64url ----------

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- JWT ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * 签发 JWT
 * @param {object} payload 业务声明（role、albumId 等）
 * @param {string} secret  签名密钥（JWT_SECRET）
 * @param {number} ttlSeconds 有效期（秒）
 */
export async function signJwt(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = bytesToB64url(enc.encode(JSON.stringify(header)));
  const p = bytesToB64url(enc.encode(JSON.stringify(body)));
  const data = `${h}.${p}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/**
 * 校验 JWT，通过返回 payload，失败/过期返回 null
 */
export async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlToBytes(s),
      enc.encode(`${h}.${p}`)
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/**
 * 从请求头解析并校验 token，返回 payload 或 null
 */
export async function getAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  if (!env.JWT_SECRET) return null;
  return verifyJwt(header.slice(7).trim(), env.JWT_SECRET);
}

/**
 * 常量时间字符串比较：先对两侧各做一次 SHA-256（归一化长度，消除长度侧信道），
 * 再用 Workers 内置的 timingSafeEqual 逐字节比较（不可用时退化为全量异或累积，无提前返回）。
 * 用于密码/哈希比对，防止时序侧信道逐字节猜测。
 */
export async function timingSafeEqualStr(a, b) {
  const da = await crypto.subtle.digest('SHA-256', enc.encode(String(a)));
  const db = await crypto.subtle.digest('SHA-256', enc.encode(String(b)));
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(da, db);
  }
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- 相册密码 ----------

// 固定前缀做域分隔，防止与其他用途的 SHA-256 值撞库
const PW_PREFIX = 'album-lock:v1:';

/**
 * 6 位数字密码 → SHA-256 十六进制。密码空间只有 100 万，
 * 防爆破主要靠接口层限速（见 index.js 的失败延迟），这里哈希只为不存明文。
 */
export async function hashPassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(PW_PREFIX + password));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 分享链接访问密码：独立前缀域分隔（允许任意字符，长度由调用方限制）
const SHARE_PW_PREFIX = 'share-lock:v1:';

export async function hashSharePassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(SHARE_PW_PREFIX + password));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
