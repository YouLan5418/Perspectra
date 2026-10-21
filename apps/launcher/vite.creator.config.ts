import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

/** 服务器只认 `/creator/` → index.html，入口文件名保持 creator.html 以免与启动器入口冲突。 */
const indexEntry: Plugin = {
  name: 'creator-index',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['creator.html']
    if (page) {
      page.fileName = 'index.html'
      bundle['index.html'] = page
      delete bundle['creator.html']
    }
  },
}

/** 创作者页面独立构建：由 playtest 服务器在 /creator/ 下提供，发行包复制到 runtime/creator-assets。 */
export default defineConfig({
  plugins: [vue(), tailwindcss(), indexEntry],
  base: '/creator/',
  publicDir: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist-creator',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./creator.html', import.meta.url)) },
  },
  server: { port: 1421, strictPort: true, open: '/creator.html' },
  clearScreen: false,
})
