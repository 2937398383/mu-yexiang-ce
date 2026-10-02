// 检查并修复根域 DNS 记录
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];
const ZONE = '64ca2504e7eaab2fa188b884ce4063c6';
const ROOT = 'cdc2937398383qqcom.dpdns.org';
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function call(method, path, body, tries = 4) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: H,
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
  // 列出所有 DNS 记录
  const list = await call('GET', `/zones/${ZONE}/dns_records?per_page=100`);
  console.log('--- 当前 DNS 记录 ---');
  for (const r of list.j.result || []) {
    console.log(`${r.type} ${r.name} -> ${r.content} (proxied=${r.proxied})`);
  }

  // 找根域的 CNAME 记录
  const rootRec = (list.j.result || []).find(r => r.type === 'CNAME' && r.name === ROOT);
  if (!rootRec) {
    console.log('\n根域没有 CNAME 记录，尝试添加...');
    const res = await call('POST', `/zones/${ZONE}/dns_records`, {
      type: 'CNAME',
      name: ROOT,
      content: 'album-web.pages.dev',
      ttl: 1,
      proxied: true,
    });
    console.log('添加结果:', res.status, res.j.success ? 'OK' : JSON.stringify(res.j.errors));
  } else {
    console.log('\n根域 CNAME 已存在:', rootRec.content);
  }
})();
