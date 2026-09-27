// 临时脚本：把 r2-cors.json 应用到 R2 桶 album-photos
const fs = require('fs');
const path = require('path');
const { AwsClient } = require('aws4fetch');

const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';
const BUCKET = 'album-photos';
const ACCESS_KEY_ID = '703861cb873ff06987c745f36408e7fe';
const SECRET_ACCESS_KEY = '6f17b5d15a0307381d38f6a52140bafbd1e5935fa2348c45dec0f5f90c39aa89';

const corsXml = jsonToS3CorsXml(JSON.parse(fs.readFileSync(path.join(__dirname, 'r2-cors.json'), 'utf8')));

function jsonToS3CorsXml(doc) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rules = doc.rules.map((r) => {
    const o = r.allowed.origins.map((x) => `<AllowedOrigin>${esc(x)}</AllowedOrigin>`).join('');
    const m = r.allowed.methods.map((x) => `<AllowedMethod>${x}</AllowedMethod>`).join('');
    const h = (r.allowed.headers || []).map((x) => `<AllowedHeader>${esc(x)}</AllowedHeader>`).join('');
    const e = (r.exposeHeaders || []).map((x) => `<ExposeHeader>${esc(x)}</ExposeHeader>`).join('');
    return `<CORSRule>${o}${m}${h}${e}${r.maxAgeSeconds ? `<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>` : ''}</CORSRule>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration>${rules}</CORSConfiguration>`;
}

async function withRetry(fn, tries = 6) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      console.log(`  attempt ${i} failed: ${e.message}, retrying...`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  throw err;
}

(async () => {
  const client = new AwsClient({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}?cors`;
  await withRetry(async () => {
    const r = await client.fetch(url, {
      method: 'PUT',
      body: corsXml,
      headers: { 'Content-Type': 'application/xml' },
    });
    if (!r.ok) throw new Error(`PUT ${r.status}: ${await r.text()}`);
    console.log('PUT cors: OK');
  });

  // 验证读回
  await withRetry(async () => {
    const g = await client.fetch(url, { method: 'GET' });
    if (!g.ok) throw new Error(`GET ${g.status}`);
    const txt = await g.text();
    console.log('GET cors verified:');
    console.log(txt);
  });
})();
