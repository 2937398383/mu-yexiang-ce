// crypto-core.js — 加密相册加解密核心（浏览器端，仅 Web Crypto，零依赖）
//
// 参考实现：
//   - bnap00/cf-ephemeral-share 的分块加密协议（nonce/AAD 防重排、防截断、防跨文件交换）
//   - ente 的分层密钥模型（口令→KEK→包裹相册主密钥→加密文件密钥→加密数据）
//
// 明文只存在于浏览器内存；服务器只接触密文与「被包裹的密钥」，永远拿不到明文内容。

const ENC_CHUNK = 8 << 20;         // 大文件分块：8 MiB 明文/块
const ENC_TAG = 16;                // AES-GCM tag 字节数
const ENC_PBKDF2_ITERS = 310000;   // 口令派生 KEK 的 PBKDF2 迭代次数（OWASP 推荐量级）

const enc_utf8 = new TextEncoder();
const enc_fromUtf8 = new TextDecoder();

/* ------------------------------------------------ 基础工具 ------------------------------------------------ */

function enc_randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function enc_b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function enc_b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function enc_concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function enc_u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// 32B raw 字节 → AES-GCM CryptoKey（不可导出）
async function enc_importKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/* ------------------------------------------------ 密钥分层 ------------------------------------------------ */

// 口令 + 盐 → KEK（仅用于包裹/解包裹相册主密钥）
async function enc_deriveKEK(password, salt, iters = ENC_PBKDF2_ITERS) {
  const base = await crypto.subtle.importKey('raw', enc_utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// 生成相册主密钥（可导出，用于加密各文件密钥）
async function enc_generateAlbumKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// 用 KEK 包裹相册主密钥 → 存 D1
async function enc_wrapAlbumKey(albumKey, kek) {
  const iv = enc_randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', albumKey, kek, { name: 'AES-GCM', iv });
  return { wrapped: enc_b64url(new Uint8Array(wrapped)), iv: enc_b64url(iv) };
}

// 用 KEK 解包裹相册主密钥
async function enc_unwrapAlbumKey(wrappedB64, ivB64, kek) {
  const wrapped = enc_b64urlDecode(wrappedB64);
  const iv = enc_b64urlDecode(ivB64);
  return crypto.subtle.unwrapKey(
    'raw', wrapped, kek, { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: 256 }, true,
    ['encrypt', 'decrypt'],
  );
}

// 生成文件密钥（raw 32B）
function enc_generateFileKeyBytes() {
  return enc_randomBytes(32);
}

// 用相册主密钥加密文件密钥 → 存 photo.enc_key
async function enc_encryptFileKey(fileKeyBytes, albumKey) {
  const iv = enc_randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, albumKey, fileKeyBytes);
  return { enc: enc_b64url(new Uint8Array(ct)), iv: enc_b64url(iv) };
}

// 解出文件密钥 bytes
async function enc_decryptFileKey(encB64, ivB64, albumKey) {
  const ct = enc_b64urlDecode(encB64);
  const iv = enc_b64urlDecode(ivB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, albumKey, ct);
  return new Uint8Array(pt);
}

/* ------------------------------------------------ 元数据加密（含大文件 header） ------------------------------------------------ */
// 格式：nonceBase(8) || GCM(meta JSON)
// meta 用 nonce = nonceBase || u32be(0)，AAD = u32be(0) || 1；body 各块复用同一 nonceBase，索引从 1 起
// 这样 header 与 body 之间也无法重排/交换（tag 会失败）。

async function enc_encryptMeta(fileKey, metaObj, nonceBase) {
  const meta = enc_utf8.encode(JSON.stringify(metaObj));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: enc_concat(nonceBase, enc_u32be(0)), additionalData: enc_concat(enc_u32be(0), new Uint8Array([1])) },
    fileKey, meta,
  );
  return enc_b64url(enc_concat(nonceBase, new Uint8Array(ct)));
}

async function enc_decryptMeta(fileKey, metaB64) {
  const raw = enc_b64urlDecode(metaB64);
  const nonceBase = raw.subarray(0, 8);
  const ct = raw.subarray(8);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: enc_concat(nonceBase, enc_u32be(0)), additionalData: enc_concat(enc_u32be(0), new Uint8Array([1])) },
    fileKey, ct,
  );
  return { meta: JSON.parse(enc_fromUtf8.decode(pt)), nonceBase };
}

/* ------------------------------------------------ 大文件分块加解密 ------------------------------------------------ */
// body = GCM(chunk0) || GCM(chunk1) || ...
// 每块 nonce = nonceBase || u32be(块索引+1)，AAD = u32be(块索引+1) || isLast
// 防重排、防丢弃、防复制、防跨文件交换、防截断（tag 校验 + 块数比对）。

async function enc_encryptStream(fileKey, nonceBase, data) {
  const chunks = Math.max(1, Math.ceil(data.length / ENC_CHUNK));
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * ENC_CHUNK;
    const slice = data.subarray(start, Math.min(start + ENC_CHUNK, data.length));
    const isLast = i === chunks - 1;
    const ct = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: enc_concat(nonceBase, enc_u32be(i + 1)),
        additionalData: enc_concat(enc_u32be(i + 1), new Uint8Array([isLast ? 1 : 0])),
      },
      fileKey, slice,
    );
    parts.push(new Uint8Array(ct));
  }
  return enc_concat(...parts);
}

async function enc_decryptStream(fileKey, nonceBase, data, chunks) {
  const cipherChunk = ENC_CHUNK + ENC_TAG;
  const out = [];
  let offset = 0;
  for (let i = 0; i < chunks; i++) {
    const isLast = i === chunks - 1;
    const expected = isLast ? Math.min(cipherChunk, data.length - offset) : cipherChunk;
    if (expected <= 0 || offset + expected > data.length) throw new Error('encrypted stream is truncated');
    const ct = data.subarray(offset, offset + expected);
    const pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: enc_concat(nonceBase, enc_u32be(i + 1)),
        additionalData: enc_concat(enc_u32be(i + 1), new Uint8Array([isLast ? 1 : 0])),
      },
      fileKey, ct,
    );
    out.push(new Uint8Array(pt));
    offset += expected;
  }
  if (offset !== data.length) throw new Error('encrypted stream has trailing bytes');
  return enc_concat(...out);
}

/* ------------------------------------------------ 小文件单块加解密（缩略图/中图） ------------------------------------------------ */
// 格式：iv(12) || GCM(data)

async function enc_encryptBlob(fileKey, data) {
  const iv = enc_randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, data);
  return enc_concat(iv, new Uint8Array(ct));
}

async function enc_decryptBlob(fileKey, blob) {
  const iv = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fileKey, ct);
  return new Uint8Array(pt);
}

// Node 测试兼容导出（浏览器普通 script 加载时 module 未定义，自动跳过）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ENC_CHUNK, ENC_PBKDF2_ITERS,
    enc_randomBytes, enc_b64url, enc_b64urlDecode, enc_importKey,
    enc_deriveKEK, enc_generateAlbumKey, enc_wrapAlbumKey, enc_unwrapAlbumKey,
    enc_generateFileKeyBytes, enc_encryptFileKey, enc_decryptFileKey,
    enc_encryptMeta, enc_decryptMeta,
    enc_encryptStream, enc_decryptStream, enc_encryptBlob, enc_decryptBlob,
  };
}
