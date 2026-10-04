<template>
  <article class="lp-native-tool" :data-status="tool.status" :data-tool-kind="tool.kind">
    <header><strong>{{ tool.kind }}<span v-if="tool.name"> · {{ tool.name }}</span></strong><span role="status">{{ labels[tool.status] }}</span></header>
    <dl v-if="tool.input || tool.result || tool.error"><template v-if="tool.input"><dt>输入</dt><dd>{{ tool.input }}</dd></template><template v-if="tool.result"><dt>结果</dt><dd>{{ tool.result }}</dd></template><template v-if="tool.error"><dt>错误</dt><dd role="alert">{{ tool.error }}</dd></template></dl>
    <p v-if="tool.unknown">当前电脑返回了新的条目类型，可展开公开详情；更新后可获得专门展示。</p>
    <details v-if="payload"><summary>查看公开详情</summary><pre>{{ payload }}</pre></details>
  </article>
</template>
<script setup lang="ts">
import type { NativeToolView } from '../../lanpower/tools'
defineProps<{tool:NativeToolView;payload?:string}>()
const labels = {inProgress:'进行中',completed:'已完成',failed:'失败',interrupted:'已停止'}
</script>
<style scoped>
.lp-native-tool { margin: 8px 0; padding: 12px; border: 1px solid var(--lp-border,#ddd); border-radius: 10px; min-width: 0; }
header { display: flex; gap: 12px; justify-content: space-between; font-size: 13px; } header span { color: var(--lp-muted,#737373); }
dl { font-size: 12px; } dt { color: var(--lp-muted,#737373); } dd { margin: 4px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; font-size: 12px; } summary { cursor: pointer; font-size: 12px; }
[data-status="failed"] { border-color: #d46b6b; } p { font-size: 12px; color: var(--lp-muted,#737373); }
</style>
