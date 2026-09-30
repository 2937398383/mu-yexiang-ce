// test-crypto.mjs — crypto-core.js 的 roundtrip 与防篡改测试（Node 运行）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('./web/crypto-core.js');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label); }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function expectThrow(fn, label) {
  try { await fn(); failed++; console.error('  ✗', label, '(未抛异常)'); }
  catch { passed++; console.log('  ✓', label); }
}

async function main() {
  console.log('== 1. 密钥分层 ==');
  const salt = new Uint8Array(16).fill(7);
  const kek = await C.enc_deriveKEK('测试口令-pass-123', salt);
  const albumKey = await C.enc_generateAlbumKey();
  const w = await C.enc_wrapAlbumKey(albumKey, kek);
  const unwrapped = await C.enc_unwrapAlbumKey(w.wrapped, w.iv, kek);
  assert(typeof w.wrapped === 'string' && typeof w.iv === 'string', 'wrap 返回 base64');
  const probe = await C.enc_encryptFileKey(C.enc_generateFileKeyBytes(), unwrapped);
  assert(typeof probe.enc === 'string', 'unwrapped albumKey 可加密');

  console.log('== 2. fileKey roundtrip ==');
  const fkBytes = C.enc_generateFileKeyBytes();
  const encFk = await C.enc_encryptFileKey(fkBytes, albumKey);
  const decFk = await C.enc_decryptFileKey(encFk.enc, encFk.iv, albumKey);
  assert(bytesEqual(fkBytes, decFk), 'fileKey 加密后解出逐字节一致');
  const fileKey = await C.enc_importKey(fkBytes);

  console.log('== 3. 元数据 roundtrip ==');
  const nonceBase = C.enc_randomBytes(8);
  const metaObj = { n: '海边日落.jpg', exif: { iso: 100, aperture: 1.8 }, camera: 'iPhone 15', size: 12345, chunks: 2 };
  const metaB64 = await C.enc_encryptMeta(fileKey, metaObj, nonceBase);
  const dec = await C.enc_decryptMeta(fileKey, metaB64);
  assert(JSON.stringify(dec.meta) === JSON.stringify(metaObj), 'meta 解密后一致');
  assert(bytesEqual(dec.nonceBase, nonceBase), 'nonceBase 还原一致');

  console.log('== 4. 小文件单块 roundtrip ==');
  const small = C.enc_randomBytes(3000);
  const smallCt = await C.enc_encryptBlob(fileKey, small);
  const smallPt = await C.enc_decryptBlob(fileKey, smallCt);
  assert(bytesEqual(small, smallPt), '小文件(3KB) 加解密一致');
  assert(smallCt.length === small.length + 12 + 16, '小文件密文长度 = 明文 + iv + tag');

  console.log('== 5. 大文件分块 roundtrip ==');
  const bigLen = C.ENC_CHUNK + 5000; // 跨 2 块
  const big = new Uint8Array(bigLen);
  for (let i = 0; i < bigLen; i++) big[i] = (i * 31) & 255;
  const bigCt = await C.enc_encryptStream(fileKey, nonceBase, big);
  const bigPt = await C.enc_decryptStream(fileKey, nonceBase, bigCt, 2);
  assert(bytesEqual(big, bigPt), `大文件(${bigLen}B, 2块) 加解密一致`);

  console.log('== 6. 防篡改 / 防截断 ==');
  await expectThrow(
    () => C.enc_decryptBlob(fileKey, (() => { const t = smallCt.slice(); t[20] ^= 1; return t; })()),
    '篡改小文件密文 1 字节 → 解密失败',
  );
  await expectThrow(
    () => C.enc_decryptMeta(fileKey, (() => { const b = C.enc_b64urlDecode(metaB64); b[10] ^= 1; return C.enc_b64url(b); })()),
    '篡改 meta 密文 → 解密失败',
  );
  await expectThrow(
    () => C.enc_decryptStream(fileKey, nonceBase, bigCt.subarray(0, bigCt.length - 4), 2),
    '截断大文件密文 → 解密失败',
  );
  const badIvBytes = C.enc_b64urlDecode(encFk.iv); badIvBytes[0] ^= 1;
  await expectThrow(
    () => C.enc_decryptFileKey(encFk.enc, C.enc_b64url(badIvBytes), albumKey),
    '错误 iv 解 fileKey → 失败',
  );

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
