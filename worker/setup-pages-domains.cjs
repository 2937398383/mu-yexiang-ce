// 临时脚本：给 Pages 项目绑定根域 + www（带重试）
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];

const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';
const ROOT = 'cdc2937398383qqcom.dpdns.org';
const api = `https://api.cloudflare.com/client/v4`;
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function cf(method, path, body, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(api + path, {
        method,
        headers: H,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbSignal(20000),
      });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  throw last;
}

function AbSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

(async () => {
  for (const name of [ROOT, `www.${ROOT}`]) {
    try {
      const p = await cf('POST', `/accounts/${ACCOUNT}/pages/projects/album-web/domains`, { name });
      console.log('[pages domain]', name, '->', p.status, p.j.success ? 'OK' : JSON.stringify(p.j.errors || p.j));
    } catch (e) {
      console.log('[pages domain]', name, '-> FAILED:', e.message);
    }
  }
})();
