// js/imgly.js — 本地 AI 抠图（@imgly/background-removal）共享工具
// 供证件照与换背景两个工具页共用；模型资源自托管于 /vendor/imgly/（importmap 解析依赖）

export let imglyModulePromise = null;

export function loadImgly() {
  if (!imglyModulePromise) {
    imglyModulePromise = import(new URL('/vendor/imgly/index.mjs', location.href));
  }
  return imglyModulePromise;
}

// 资源 key → 友好名称
export function resourceLabel(key) {
  if (key.includes('isnet_quint8')) return 'AI 模型';
  if (key.includes('.wasm')) return 'AI 推理引擎';
  if (key.includes('.mjs')) return 'AI 推理引擎';
  return key;
}

// 将图片绘制到 canvas 并输出 data URI（限制最长边，减小上传体积）
export function imageToDataUri(img, maxEdge, type = 'image/jpeg', quality = 0.92) {
  let { width, height } = img;
  if (Math.max(width, height) > maxEdge) {
    const s = maxEdge / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d').drawImage(img, 0, 0, width, height);
  return c.toDataURL(type, quality);
}
