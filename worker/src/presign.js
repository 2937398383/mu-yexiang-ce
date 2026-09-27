// R2 预签名 URL 生成（SigV4 query 签名，基于 aws4fetch）
// 前端拿到的 PUT/GET URL 直连 R2 S3 端点，不经过 Worker，不产生出口流量费
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

/**
 * 生成 R2 对象的预签名 URL
 * @param {string} method 'PUT'（上传）| 'GET'（浏览/下载）
 * @param {string} objectKey 对象键，如 albums/<albumId>/<uuid>.jpg
 * @param {number} expiresSeconds 有效期
 * @returns {Promise<string>} 签名后的完整 URL
 */
export async function presignR2(env, method, objectKey, expiresSeconds) {
  // virtual-hosted 风格：https://<bucket>.<accountId>.r2.cloudflarestorage.com/<key>
  const url = new URL(
    `https://${env.R2_BUCKET}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${objectKey}`
  );
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const request = new Request(url, { method });
  const signed = await getClient(env).sign(request, { aws: { signQuery: true } });
  return signed.url;
}
