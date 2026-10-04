<template>
  <p v-if="elapsed" class="thread-work-elapsed">已处理 {{ elapsed }}</p>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatWorkDuration } from '../../lanpower/turnPresentation'
const props = defineProps<{startedAtMs?:number}>()
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
const elapsed = computed(() => props.startedAtMs === undefined ? '' : formatWorkDuration(now.value - props.startedAtMs))
watch(() => props.startedAtMs, () => {
  clearInterval(ticker); ticker = undefined; now.value = Date.now()
  if (props.startedAtMs !== undefined) ticker = setInterval(() => { now.value = Date.now() },1000)
}, { immediate:true })
onBeforeUnmount(() => clearInterval(ticker))
</script>
<style scoped>
.thread-work-elapsed { width: 100%; margin: 0; padding: 4px 0 12px; border-bottom: 1px solid var(--lp-border,#ececec); color: var(--lp-muted,#737373); font-size: 14px; line-height: 1.6; font-variant-numeric: tabular-nums; }
</style>
