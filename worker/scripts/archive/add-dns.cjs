// 临时脚本：补 DNS 记录 www/root -> Pages（代理开启）
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];
const ZONE = '64ca2504e7eaab2fa188b884ce4063c6';
const ROOT = 'cdc2937398383qqcom.dpdns.org';
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function call(method, path, body, tries = 5) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: H,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
  throw err;
}

(async () => {
  const targets = [
    { type: 'CNAME', name: `www.${ROOT}`, content: 'album-web.pages.dev' },
    { type: 'CNAME', name: ROOT, content: 'album-web.pages.dev' }, // 根域走 CNAME flattening
  ];
  for (const rec of targets) {
    const res = await call('POST', `/zones/${ZONE}/dns_records`, {
      ...rec,
      ttl: 1,
      proxied: true,
    });
    console.log(rec.name, '->', res.status, res.j.success ? 'OK' : JSON.stringify(res.j.errors));
  }

  // 复查列表
  const list = await call('GET', `/zones/${ZONE}/dns_records?per_page=100`);
  console.log('--- records now ---');
  for (const r of list.j.result || []) {
    console.log(`${r.type} ${r.name} -> ${r.content} (proxied=${r.proxied})`);
  }
})();
