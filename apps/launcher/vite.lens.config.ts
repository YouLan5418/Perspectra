import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

/** 服务器只认 `/lens/` → index.html，入口文件名保持 lens.html 以免与启动器入口冲突。 */
const indexEntry: Plugin = {
  name: 'lens-index',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['lens.html']
    if (page) {
      page.fileName = 'index.html'
      bundle['index.html'] = page
      delete bundle['lens.html']
    }
  },
}

/** 透视页面独立构建：由透视本机服务在 /lens/ 下提供，发行包复制到 runtime/lens-assets。 */
export default defineConfig({
  plugins: [vue(), tailwindcss(), indexEntry],
  base: '/lens/',
  publicDir: false,
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }],
  },
  build: {
    outDir: 'dist-lens',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./lens.html', import.meta.url)) },
  },
  server: { port: 1422, strictPort: true, open: '/lens.html' },
  clearScreen: false,
})
