<template>
  <button type="button" class="native-activity-toggle" :aria-expanded="summary.expanded" @click="$emit('toggle', $event)">
    <IconTablerFilePencil v-if="summary.hasFiles" class="native-activity-icon" />
    <IconTablerTerminal v-else-if="summary.hasCommands" class="native-activity-icon terminal-icon" />
    <IconTablerGlobe v-else class="native-activity-icon" />
    <span>{{ summary.label }}</span>
    <span v-if="summary.notice" class="native-activity-notice">{{ summary.notice }}</span>
    <IconTablerChevronDown class="native-activity-chevron" :class="{'is-open': summary.expanded}" />
  </button>
</template>
<script setup lang="ts">
import type { ActivitySummary } from '../../lanpower/conversationPresentation'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerTerminal from '../icons/IconTablerTerminal.vue'
import IconTablerGlobe from '../icons/IconTablerGlobe.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
defineProps<{summary: ActivitySummary}>()
defineEmits<{toggle: [event: MouseEvent]}>()
</script>
<style scoped>
.native-activity-toggle { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 26px; max-width: 100%; padding: 2px 0; border: 0; background: transparent; color: var(--lp-muted,#737373); font-size: 14px; line-height: 1.6; text-align: left; }
.native-activity-toggle:hover { color: var(--lp-text,#262626); }
.native-activity-toggle[aria-expanded='true'] { color:var(--lp-text,#262626); }
.native-activity-icon { width: 17px; height: 17px; flex-shrink: 0; }
.terminal-icon { border: 1px solid currentColor; border-radius: 4px; padding: 2px; }
.native-activity-notice { color: #b24b48; font-size: 12px; }
.native-activity-chevron { width: 14px; height: 14px; flex-shrink: 0; transition: transform .15s; }
.native-activity-chevron.is-open { transform: rotate(180deg); }
@media (prefers-reduced-motion:reduce) { .native-activity-chevron { transition: none; } }
</style>
