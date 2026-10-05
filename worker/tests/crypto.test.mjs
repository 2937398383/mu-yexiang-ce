// crypto-core.js 的 roundtrip 与防篡改测试（node --test）
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../web/crypto-core.js';

let salt, kek, albumKey, fkBytes, fileKey, nonceBase;

before(async () => {
  salt = new Uint8Array(16).fill(7);
  kek = await C.enc_deriveKEK('测试口令-pass-123', salt);
  albumKey = await C.enc_generateAlbumKey();
  fkBytes = C.enc_generateFileKeyBytes();
  fileKey = await C.enc_importKey(fkBytes);
  nonceBase = C.enc_randomBytes(8);
});

describe('密钥分层', () => {
  test('wrap → unwrap 还原相册主密钥', async () => {
    const w = await C.enc_wrapAlbumKey(albumKey, kek);
    assert.equal(typeof w.wrapped, 'string');
    assert.equal(typeof w.iv, 'string');
    const unwrapped = await C.enc_unwrapAlbumKey(w.wrapped, w.iv, kek);
    const probe = await C.enc_encryptFileKey(C.enc_generateFileKeyBytes(), unwrapped);
    assert.equal(typeof probe.enc, 'string');
  });
});

describe('fileKey roundtrip', () => {
  test('加密后解出逐字节一致', async () => {
    const encFk = await C.enc_encryptFileKey(fkBytes, albumKey);
    const decFk = await C.enc_decryptFileKey(encFk.enc, encFk.iv, albumKey);
    assert.deepEqual([...decFk], [...fkBytes]);
  });
});

describe('元数据 roundtrip', () => {
  test('meta 解密一致且 nonceBase 还原', async () => {
    const metaObj = { n: '海边日落.jpg', exif: { iso: 100, aperture: 1.8 }, camera: 'iPhone 15', size: 12345, chunks: 2 };
    const metaB64 = await C.enc_encryptMeta(fileKey, metaObj, nonceBase);
    const dec = await C.enc_decryptMeta(fileKey, metaB64);
    assert.deepEqual(dec.meta, metaObj);
    assert.deepEqual([...dec.nonceBase], [...nonceBase]);
  });
});

describe('小文件单块 roundtrip', () => {
  test('3KB 明文加解密一致', async () => {
    const small = C.enc_randomBytes(3000);
    const smallCt = await C.enc_encryptBlob(fileKey, small);
    const smallPt = await C.enc_decryptBlob(fileKey, smallCt);
    assert.deepEqual([...smallPt], [...small]);
    assert.equal(smallCt.length, small.length + 12 + 16);
  });
});

describe('大文件分块 roundtrip', () => {
  test('跨 2 块加解密一致', async () => {
    const bigLen = C.ENC_CHUNK + 5000;
    const big = new Uint8Array(bigLen);
    for (let i = 0; i < bigLen; i++) big[i] = (i * 31) & 255;
    const bigCt = await C.enc_encryptStream(fileKey, nonceBase, big);
    const bigPt = await C.enc_decryptStream(fileKey, nonceBase, bigCt, 2);
    assert.deepEqual([...bigPt], [...big]);
  });
});

describe('防篡改 / 防截断 / 防重放', () => {
  test('篡改小文件密文 → 解密失败', async () => {
    const small = C.enc_randomBytes(3000);
    const smallCt = await C.enc_encryptBlob(fileKey, small);
    const tampered = smallCt.slice();
    tampered[20] ^= 1;
    await assert.rejects(() => C.enc_decryptBlob(fileKey, tampered));
  });

  test('篡改 meta 密文 → 解密失败', async () => {
    const metaB64 = await C.enc_encryptMeta(fileKey, { n: 'a.jpg' }, nonceBase);
    const b = C.enc_b64urlDecode(metaB64);
    b[10] ^= 1;
    await assert.rejects(() => C.enc_decryptMeta(fileKey, C.enc_b64url(b)));
  });

  test('截断大文件密文 → 解密失败', async () => {
    const bigLen = C.ENC_CHUNK + 5000;
    const big = new Uint8Array(bigLen);
    const bigCt = await C.enc_encryptStream(fileKey, nonceBase, big);
    await assert.rejects(() =>
      C.enc_decryptStream(fileKey, nonceBase, bigCt.subarray(0, bigCt.length - 4), 2));
  });

  test('错误 iv 解 fileKey → 失败', async () => {
    const encFk = await C.enc_encryptFileKey(fkBytes, albumKey);
    const badIv = C.enc_b64urlDecode(encFk.iv);
    badIv[0] ^= 1;
    await assert.rejects(() => C.enc_decryptFileKey(encFk.enc, C.enc_b64url(badIv), albumKey));
  });
});
