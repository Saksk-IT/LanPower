<template>
  <div class="lp-token-status" role="status">
    <strong>上下文 <span v-if="usage?.remainingContextPercent !== null && usage">{{ usage.remainingContextPercent }}% 剩余</span></strong>
    <p v-if="usage">当前 {{ usage.currentContextTokens.toLocaleString() }}<template v-if="usage.modelContextWindow"> / {{ usage.modelContextWindow.toLocaleString() }}</template> tokens · 累计 {{ usage.total.totalTokens.toLocaleString() }} tokens</p>
    <p v-if="reason" class="lp-native-reason">{{ reason }}</p>
  </div>
</template>
<script setup lang="ts">
import type { UiThreadTokenUsage } from '../../types/codex'
defineProps<{usage: UiThreadTokenUsage | null; reason: string}>()
</script>
