<template>
  <section class="native-web-search" :data-status="tool.status">
    <button type="button" class="native-web-search-toggle" :aria-expanded="expanded" :title="tool.webSearch?.label" @click="expanded = !expanded">
      <IconTablerGlobe class="native-web-search-icon" />
      <span class="native-web-search-label">{{ tool.webSearch?.label }}</span>
    </button>
    <div v-if="expanded" class="native-web-search-details">
      <p v-if="tool.webSearch?.summary">{{ tool.webSearch.summary }}</p>
      <p v-if="tool.error" role="alert">{{ tool.error }}</p>
      <pre v-if="payload">{{ payload }}</pre>
    </div>
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import type { NativeToolView } from '../../lanpower/tools'
import IconTablerGlobe from '../icons/IconTablerGlobe.vue'
defineProps<{tool: NativeToolView; payload?: string}>()
const expanded = ref(false)
</script>
<style scoped>
.native-web-search { width:100%;min-width:0;color:var(--lp-muted,#737373);font-size:14px; }
.native-web-search-toggle { display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:26px;padding:2px 0;border:0;background:transparent;color:inherit;line-height:1.6;text-align:left; }
.native-web-search-toggle:hover { color:var(--lp-text,#262626); }
.native-web-search-icon { width:17px;height:17px;flex-shrink:0; }
.native-web-search-label { min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.native-web-search[data-status='failed'] { color:#b24b48; }
.native-web-search-details { margin:8px 0 10px 25px;padding:10px 12px;border:1px solid var(--lp-border,#e5e5e5);border-radius:10px;background:var(--lp-sidebar,#fafafa);color:var(--lp-text,#262626); }
.native-web-search-details p,.native-web-search-details pre { margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6; }
.native-web-search-details pre { margin:0;max-height:360px;overflow:auto; }
@media (max-width:640px) { .native-web-search-details { margin-left:0; } }
</style>
