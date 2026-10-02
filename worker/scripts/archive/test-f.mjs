// 补测：messages + 顶层 image 字节数组（Cloudflare 官方 binding 示例结构）
import { readFileSync } from 'node:fs';

const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';
const TOKEN = process.argv[2];
const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const imgBytes = [...readFileSync('../web/bg-default.jpg')];

async function call(label, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  const usage = j?.result?.usage;
  console.log(`=== ${label} → HTTP ${r.status} ===`);
  console.log('  response:', JSON.stringify(j?.result?.response ?? j?.errors ?? j).slice(0, 300));
  console.log('  prompt_tokens:', usage?.prompt_tokens ?? '-', 'neurons:', usage?.neurons ?? '-');
}

// F. messages(system+user) + 顶层 image 字节数组（官方 binding 示例结构）
await call('F. messages + 顶层image(字节数组)', {
  messages: [
    { role: 'system', content: '你是照片标签助手，只输出JSON。' },
    { role: 'user', content: '为这张照片生成标签JSON：{"tags":["主体","场景","行为","特征"]}' },
  ],
  image: imgBytes,
  temperature: 0.2,
  max_tokens: 200,
  repetition_penalty: 1.15,
});
