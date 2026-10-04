<template>
  <section class="native-image-activity">
    <button type="button" class="native-image-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
      <svg class="native-image-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 4V3a1 1 0 0 1 1-1h11a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1h-1" />
        <rect x="2" y="7" width="15" height="15" rx="3" />
        <circle cx="7" cy="12" r="1" />
        <path d="m3 19 4-4 3 3 3-4 4 5" />
      </svg>
      <span>{{ action === 'generate' ? '已生成' : '已查看' }} {{ images.length }} 张图像</span>
      <IconTablerChevronDown class="native-image-chevron" :class="{ 'is-open': expanded }" />
    </button>
    <ul v-if="expanded" class="native-image-previews">
      <li v-for="(source, index) in images" :key="`${index}:${source}`">
        <RemoteMessageImage :source="source" :thread-id="threadId" :cwd="cwd" :thumbnail="false" compact :alt="action === 'generate' ? '生成的图片' : '已查看的图片'" @open="emit('open', $event)" />
      </li>
    </ul>
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import RemoteMessageImage from './RemoteMessageImage.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
defineProps<{images:string[];threadId:string;cwd:string;action?:'view' | 'generate'}>()
const emit = defineEmits<{open:[url:string]}>()
const expanded = ref(false)
</script>
<style scoped>
.native-image-activity { width: 100%; min-width: 0; color: var(--lp-muted,#737373); font-size: 14px; }
.native-image-toggle { display: flex; align-items: center; gap: 8px; min-height: 26px; max-width: 100%; padding: 2px 0; border: 0; background: transparent; color: inherit; line-height: 1.6; text-align: left; cursor: pointer; }
.native-image-toggle:hover { color: var(--lp-text,#262626); }
.native-image-icon { width: 20px; height: 20px; flex-shrink: 0; }
.native-image-chevron { width: 14px; height: 14px; flex-shrink: 0; transition: transform .15s; }
.native-image-chevron.is-open { transform: rotate(180deg); }
.native-image-previews { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 10px 0 8px; padding: 0; }
.native-image-previews li { min-width: 0; max-width: 100%; }
@media (prefers-reduced-motion:reduce) { .native-image-chevron { transition: none; } }
</style>
