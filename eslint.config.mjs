// ESLint flat config：worker（ESM/node）与 web（经典脚本/browser）分环境检查
// 原则：只检查不自动改；vendor/归档脚本/构建产物不检查
import js from '@eslint/js';

// 浏览器全局（手写最小集，避免引入 globals 依赖）
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  history: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', FormData: 'readonly', Blob: 'readonly',
  File: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  createImageBitmap: 'readonly', requestIdleCallback: 'readonly',
  IntersectionObserver: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
  CustomEvent: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly',
  MediaSource: 'readonly', webkitAudioContext: 'readonly',
  // vendor UMD 全局（script 标签加载，importmap 已自托管）
  exifr: 'readonly', imageCompression: 'readonly', JSZip: 'readonly',
  heic2any: 'readonly', thumbhash: 'readonly', L: 'readonly', Hls: 'readonly',
};

const nodeGlobals = {
  console: 'readonly', process: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  crypto: 'readonly', atob: 'readonly', btoa: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly',
  FormData: 'readonly', Blob: 'readonly', Request: 'readonly', Response: 'readonly',
  Headers: 'readonly', AbortController: 'readonly', structuredClone: 'readonly',
  caches: 'readonly', performance: 'readonly',
};

export default [
  {
    ignores: [
      'web/vendor/**', 'worker/scripts/**', 'worker/.wrangler/**', 'web/.wrangler/**',
      'worker/.cf-home/**', 'worker/.tmp-ai-test/**', 'node_modules/**', '.trae/**', '.zcode/**',
    ],
  },
  js.configs.recommended,
  {
    // Worker 源码与测试：ESM
    files: ['worker/src/**/*.js', 'worker/*.mjs', 'worker/tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-console': 'off',          // Worker 日志是主要可观测手段
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true }], // 允许 { _row, ...rest } 剔除字段
    },
  },
  {
    // worker 根目录运维脚本：CommonJS (.cjs) 与 ESM (.mjs)
    files: ['worker/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Pages Functions：ESM（随 Pages 部署打包）
    files: ['web/functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 前端：经典脚本（无构建，script 标签全局加载）
    files: ['web/**/*.js'],
    ignores: ['web/vendor/**', 'web/functions/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 经典脚本跨文件共享全局（app.js ↔ 工具页函数互调），no-undef/no-unused-vars
      // 必然大量误报——S5 拆分 ES modules 后恢复默认并归零
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
