// 临时脚本：绑定自定义域名（Worker api + Pages www/根域）
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];

const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';
const ZONE = '64ca2504e7eaab2fa188b884ce4063c6';
const ROOT = 'cdc2937398383qqcom.dpdns.org';
const api = `https://api.cloudflare.com/client/v4`;
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function cf(method, path, body) {
  const r = await fetch(api + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

(async () => {
  // 1. Worker 自定义域名：api.<root> -> album-api
  const list = await cf('GET', `/accounts/${ACCOUNT}/workers/domains`);
  const exists = list.j.success && list.j.result.some((d) => d.hostname === `api.${ROOT}`);
  if (exists) {
    console.log('[skip] worker domain api.' + ROOT + ' already exists');
  } else {
    const w = await cf('POST', `/accounts/${ACCOUNT}/workers/domains`, {
      environment: 'production',
      hostname: `api.${ROOT}`,
      service: 'album-api',
      zone_id: ZONE,
    });
    console.log('[worker domain]', w.status, w.j.success ? 'OK' : JSON.stringify(w.j.errors));
  }

  // 2. Pages 自定义域名：根域 + www
  for (const name of [ROOT, `www.${ROOT}`]) {
    const p = await cf('PUT', `/accounts/${ACCOUNT}/pages/projects/album-web/domains/${name}`, {
      name,
    });
    console.log('[pages domain]', name, p.status, p.j.success ? 'OK' : JSON.stringify(p.j.errors));
  }
})();
