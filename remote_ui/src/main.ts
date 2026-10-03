import { createApp } from 'vue'
import App from './LanPowerApp.vue'
import './style.css'
import './lanpower/style.css'
import './lanpower/workspace.css'
import { useUiLanguage } from './composables/useUiLanguage'
useUiLanguage().setUiLanguage('zh-CN')
createApp(App).mount('#codex-app')
