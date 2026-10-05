import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version
export default defineConfig({
  base: '/static/codex-ui/',
  plugins: [vue(), tailwind()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  build: { outDir: '../cloud_app/static/codex-ui', emptyOutDir: true, sourcemap: false, manifest: true,
    commonjsOptions: { include: [/node_modules/, /mini_program[\\/]utils[\\/]codex[\\/](native-status|web-search)\.js$/] },
    rollupOptions: { output: { entryFileNames: 'codex.js', assetFileNames: asset => asset.name?.endsWith('.css') ? 'codex.css' : 'assets/[name]-[hash][extname]' } } },
})
