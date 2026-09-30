// R2 预签名 URL 生成（SigV4 query 签名，基于 aws4fetch）
// 前端拿到的 PUT/GET URL 直连 R2 S3 端点，不经过 Worker，不产生出口流量费
// 大视频分段上传（Multipart Upload）：控制面（initiate/complete/abort）由 Worker 直连 S3 端点，
// 数据面（各分段 PUT）仍走预签名直传，避免文件流量过 Worker。
import { AwsClient } from 'aws4fetch';

let cachedClient = null;
let cachedEnvKey = '';

function getClient(env) {
  const envKey = `${env.R2_ACCESS_KEY_ID}:${env.R2_SECRET_ACCESS_KEY}`;
  if (!cachedClient || cachedEnvKey !== envKey) {
    cachedClient = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    });
    cachedEnvKey = envKey;
  }
  return cachedClient;
}

// virtual-hosted 风格：https://<bucket>.<accountId>.r2.cloudflarestorage.com/<key>
function r2Url(env, objectKey) {
  return `https://${env.R2_BUCKET}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${objectKey}`;
}

/**
 * 生成 R2 对象的预签名 URL
 * @param {string} method 'PUT'（上传）| 'GET'（浏览/下载）
 * @param {string} objectKey 对象键，如 albums/<albumId>/<uuid>.jpg
 * @param {number} expiresSeconds 有效期
 * @param {object} [opts]
 * @param {string} [opts.cacheControl] GET 时覆盖响应 Cache-Control（如 'public, max-age=31536000, immutable'）
 * @param {object} [opts.query] 额外的 S3 查询参数（如分段上传的 partNumber/uploadId，会一并签名）
 * @returns {Promise<string>} 签名后的完整 URL
 */
export async function presignR2(env, method, objectKey, expiresSeconds, opts = {}) {
  const url = new URL(r2Url(env, objectKey));
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  // R2 S3 兼容：response-cache-control 覆盖对象存储的 Cache-Control 元数据
  if (method === 'GET' && opts.cacheControl) {
    url.searchParams.set('response-cache-control', opts.cacheControl);
  }
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const request = new Request(url, { method });
  const signed = await getClient(env).sign(request, { aws: { signQuery: true } });
  return signed.url;
}

// 解析 S3 返回 XML 中的单个标签（仅用于短标签，如 UploadId）
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

function escapeXml(s) {
  return String(s).replace(/[&<>'"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** 发起分段上传，返回 uploadId */
export async function initiateMultipart(env, objectKey) {
  const resp = await getClient(env).fetch(r2Url(env, objectKey) + '?uploads', { method: 'POST' });
  if (!resp.ok) throw new Error(`multipart initiate HTTP ${resp.status}`);
  const uploadId = xmlTag(await resp.text(), 'UploadId');
  if (!uploadId) throw new Error('multipart initiate: no UploadId');
  return uploadId;
}

/** 完成分段上传（parts: [{partNumber, etag}]，etag 需保留 S3 返回的引号） */
export async function completeMultipart(env, objectKey, uploadId, parts) {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CompleteMultipartUpload>' +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  const resp = await getClient(env).fetch(
    r2Url(env, objectKey) + `?uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'POST', body }
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`multipart complete HTTP ${resp.status} ${detail.slice(0, 200)}`);
  }
}

/** 放弃分段上传（清理未完成分段，避免 R2 泄漏计费） */
export async function abortMultipart(env, objectKey, uploadId) {
  const resp = await getClient(env).fetch(
    r2Url(env, objectKey) + `?uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'DELETE' }
  );
  return resp.ok;
}
