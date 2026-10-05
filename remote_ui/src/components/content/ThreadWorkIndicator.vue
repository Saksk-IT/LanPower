<template>
  <section class="thread-work-indicator" :aria-busy="running">
    <details v-if="reasoningText" class="thread-work-reasoning">
      <summary><IconReasoning class="thread-work-icon" /><span class="thread-work-label" :class="{ 'is-working': running }" role="status">{{ label }}</span><IconTablerChevronDown class="thread-work-chevron" /></summary>
      <div class="thread-work-summary"><slot>{{ reasoningText }}</slot></div>
    </details>
    <p v-else class="thread-work-label" :class="{ 'is-working': running }" role="status">{{ label }}</p>
  </section>
</template>
<script setup lang="ts">
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconReasoning from '../icons/IconReasoning.vue'
defineProps<{label:string;running:boolean;reasoningText?:string}>()
</script>
<style scoped>
.thread-work-indicator { width: 100%; color: var(--lp-muted,#737373); padding: 4px 0 8px; font-size: 14px; line-height: 1.6; }
.thread-work-label { margin: 0; font-weight: 400; color: var(--lp-muted,#737373); }
.is-working { width: fit-content; background: linear-gradient(100deg,var(--lp-muted,#737373) 30%,var(--lp-surface,#fff) 50%,var(--lp-muted,#737373) 70%); background-size: 220% 100%; background-clip: text; -webkit-background-clip: text; color: transparent; animation: thread-work-shimmer 2s linear infinite; }
.thread-work-reasoning summary { display: flex; width: fit-content; align-items: center; gap: 8px; min-height:26px; padding:2px 0; cursor: pointer; list-style: none; }
.thread-work-reasoning summary::-webkit-details-marker { display: none; }
.thread-work-icon { width:17px;height:17px;flex-shrink:0; }
.thread-work-chevron { width:14px;height:14px;flex-shrink:0;transition:transform .15s; }
.thread-work-reasoning[open] .thread-work-chevron { transform: rotate(180deg); }
.thread-work-summary { padding-top: 10px; overflow-wrap: anywhere; white-space: pre-wrap; }
.thread-work-summary :deep(.message-text) { margin: 0; font-size: inherit; color: inherit; line-height: inherit; }
@keyframes thread-work-shimmer { from { background-position: 150% 0; } to { background-position: -70% 0; } }
@media (prefers-reduced-motion:reduce) { .is-working { animation: none; background: none; color: var(--lp-muted,#737373); } .thread-work-chevron { transition: none; } }
</style>
