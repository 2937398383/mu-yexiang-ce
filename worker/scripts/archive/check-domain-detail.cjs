// 查看 Pages 域名详细状态
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];

(async () => {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/65e1870ebd61513b5e09664b1673a5ed/pages/projects/album-web/domains', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  for (const d of j.result) {
    console.log(JSON.stringify(d, null, 2));
  }
})();
