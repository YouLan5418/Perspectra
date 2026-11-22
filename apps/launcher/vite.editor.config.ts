import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const indexEntry: Plugin = {
  name: 'editor-index',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['editor.html']
    if (page) {
      page.fileName = 'index.html'
      bundle['index.html'] = page
      delete bundle['editor.html']
    }
  },
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), indexEntry],
  base: '/editor/',
  publicDir: false,
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }],
  },
  build: {
    outDir: 'dist-editor',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./editor.html', import.meta.url)) },
  },
  clearScreen: false,
})
