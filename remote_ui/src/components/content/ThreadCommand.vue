<template>
  <section class="native-command" :data-status="execution.status">
    <button type="button" class="native-command-toggle" :aria-expanded="expanded" :title="execution.command" @click="expanded = !expanded">
      <IconTablerTerminal class="native-command-icon" :class="{ 'is-running': execution.status === 'inProgress' }" />
      <span>{{ label }}</span><IconTablerChevronDown class="native-command-chevron" :class="{ 'is-open': expanded }" />
    </button>
    <div v-if="expanded" class="native-command-details">
      <code class="native-command-source">{{ execution.command || '命令内容不可用' }}</code>
      <p v-if="execution.cwd || execution.exitCode !== null" class="native-command-meta"><span v-if="execution.cwd">{{ execution.cwd }}</span><span v-if="execution.exitCode !== null">退出码 {{ execution.exitCode }}</span></p>
      <pre class="native-command-output">{{ execution.aggregatedOutput || (execution.status === 'inProgress' ? '等待命令输出…' : '没有命令输出') }}</pre>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CommandExecutionData } from '../../types/codex'
import IconTablerTerminal from '../icons/IconTablerTerminal.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
const props = defineProps<{execution:CommandExecutionData}>()
const expanded = ref(false)
const label = computed(() => {
  const {status,exitCode} = props.execution
  if (status === 'inProgress') return '正在运行命令'
  if (status === 'failed' || (status === 'completed' && exitCode !== null && exitCode !== 0)) return '命令运行失败'
  if (status === 'declined') return '命令已拒绝'
  if (status === 'interrupted') return '命令已停止'
  return '已运行命令'
})
</script>
<style scoped>
.native-command { width: 100%; min-width: 0; color: var(--lp-muted,#737373); font-size: 14px; }
.native-command-toggle { display: flex; align-items: center; gap: 8px; min-height: 26px; max-width: 100%; padding: 2px 0; border: 0; background: transparent; color: inherit; line-height: 1.6; text-align: left; }
.native-command-toggle:hover { color: var(--lp-text,#262626); }
.native-command-icon { width: 17px; height: 17px; flex-shrink: 0; border: 1px solid currentColor; border-radius: 4px; padding: 2px; }
.native-command-chevron { width: 14px; height: 14px; transition: transform .15s; }
.native-command-chevron.is-open { transform: rotate(180deg); }
.native-command[data-status='failed'] .native-command-toggle { color: #b24b48; }
.native-command-details { margin: 8px 0 10px 25px; padding: 12px 14px; border: 1px solid var(--lp-border,#e5e5e5); border-radius: 10px; background: var(--lp-sidebar,#fafafa); color: var(--lp-text,#262626); min-width: 0; }
.native-command-source { display: block; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.native-command-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--lp-muted,#737373); font-size: 11px; margin: 8px 0; overflow-wrap: anywhere; }
.native-command-output { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--lp-border,#e5e5e5); font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
.is-running { animation: native-command-pulse 1.5s ease-in-out infinite; }
@keyframes native-command-pulse { 50% { opacity: .35; } }
@media (max-width:640px) { .native-command-details { margin-left: 0; } }
@media (prefers-reduced-motion:reduce) { .is-running { animation: none; } .native-command-chevron { transition: none; } }
</style>
