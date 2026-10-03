import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
export default defineConfig({
  base: '/static/codex-ui/',
  plugins: [vue(), tailwind()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify('1.14.0') },
  build: { outDir: '../cloud_app/static/codex-ui', emptyOutDir: true, sourcemap: false, manifest: true,
    rollupOptions: { output: { entryFileNames: 'codex.js', assetFileNames: asset => asset.name?.endsWith('.css') ? 'codex.css' : 'assets/[name]-[hash][extname]' } } },
})
