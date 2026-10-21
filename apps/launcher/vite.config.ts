import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Only the browser-safe subpaths provider-chat exports; its main entry pulls in Node modules.
      {
        find: /^@harness-world\/provider-chat\/(preset(?:-library|-macros|-regex)?)$/,
        replacement: fileURLToPath(new URL('../../packages/provider-chat/src/$1.ts', import.meta.url)),
      },
    ],
  },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
})
