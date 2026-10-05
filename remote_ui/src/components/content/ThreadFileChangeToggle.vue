<template>
  <button type="button" class="file-change-summary-row" :aria-expanded="expanded" :title="`${summary.label} · ${summary.kinds}`" @click="$emit('toggle')">
    <IconFileDiff class="file-change-summary-icon" />
    <span class="file-change-summary-text"><span class="file-change-summary-label">{{ summary.label }}</span><span class="file-change-summary-kinds">{{ summary.kinds }}</span></span>
    <span v-if="summary.added || summary.removed" class="file-change-summary-status">
      <span v-if="summary.added" class="file-change-signed-count" data-tone="add">+{{ summary.added }}</span>
      <span v-if="summary.removed" class="file-change-signed-count" data-tone="remove">-{{ summary.removed }}</span>
    </span>
    <IconTablerChevronDown class="file-change-summary-chevron" :class="{'is-open': expanded}" />
  </button>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { UiFileChange } from '../../types/codex'
import { fileChangeSummary } from '../../../../mini_program/utils/codex/file-changes.js'
import IconFileDiff from '../icons/IconFileDiff.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
const props = defineProps<{changes: UiFileChange[]; expanded: boolean}>()
defineEmits<{toggle: []}>()
const summary = computed(() => fileChangeSummary(props.changes))
</script>
<style scoped>
.file-change-summary-row { display:flex;align-items:center;gap:8px;width:fit-content;max-width:100%;min-height:26px;margin:0;padding:2px 0;border:0;border-radius:0;background:transparent;color:var(--lp-muted,#737373);font-size:14px;font-weight:400;line-height:1.6;text-align:left;cursor:pointer; }
.file-change-summary-row:hover { color:var(--lp-text,#262626); }
.file-change-summary-icon { width:17px;height:17px;flex-shrink:0; }
.file-change-summary-text { display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;min-width:0; }
.file-change-summary-label { white-space:nowrap; }
.file-change-summary-kinds { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px; }
.file-change-summary-status { display:inline-flex;gap:6px;flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap; }
.file-change-signed-count[data-tone='add'] { color:var(--lp-file-add,#13845b); }
.file-change-signed-count[data-tone='remove'] { color:var(--lp-file-remove,#c44d56); }
.file-change-summary-chevron { width:14px;height:14px;flex-shrink:0;transition:transform .15s; }
.file-change-summary-chevron.is-open { transform:rotate(180deg); }
:global(.dark) .file-change-summary-row { --lp-file-add:#6ad5a1;--lp-file-remove:#f5929b; }
@media (prefers-reduced-motion:reduce) { .file-change-summary-chevron { transition:none; } }
</style>
