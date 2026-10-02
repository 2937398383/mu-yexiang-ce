// 临时脚本：用阿里/腾讯 DoH（国内可达）查域名真实 IP
async function doh(name, server) {
  const u = `${server}?name=${encodeURIComponent(name)}&type=A`;
  const r = await fetch(u, { headers: { accept: 'application/dns-json' } });
  return r.json();
}

(async () => {
  const name = 'www.cdc2937398383qqcom.dpdns.org';
  for (const [label, server] of [
    ['AliDNS', 'https://dns.alidns.com/resolve'],
    ['TencentDNSPod', 'https://doh.pub/dns-query'],
  ]) {
    try {
      const j = await doh(name, server);
      console.log(`[${label}]`, (j.Answer || []).map((a) => a.data).join(', ') || `no answer (status ${j.Status})`);
    } catch (e) {
      console.log(`[${label}] failed: ${e.message}`);
    }
  }
})();
