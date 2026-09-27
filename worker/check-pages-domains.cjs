// 临时脚本：查 Pages 自定义域名状态（证书/DNS）
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];
const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';

async function get(path, tries = 4) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(20000),
      });
      return await r.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  throw err;
}

(async () => {
  const j = await get(`/accounts/${ACCOUNT}/pages/projects/album-web/domains`);
  if (!j.success) {
    console.log('error:', JSON.stringify(j.errors));
    return;
  }
  for (const d of j.result) {
    console.log(d.name, '| status:', d.status, '| cert:', JSON.stringify(d.cert || {}));
  }
})();
