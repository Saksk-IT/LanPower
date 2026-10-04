<template>
  <div ref="root" class="lp-permission-picker" @keydown.esc.stop="close">
    <button ref="trigger" class="lp-permission-trigger" :class="{'is-full': mode === 'full-access'}" type="button"
      aria-label="更改 Codex 权限" aria-haspopup="menu" :aria-expanded="open" :disabled="disabled || changing"
      @click="open = !open">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3 21 7v6c0 4-5 7-9 8-4-1-9-4-9-8V7l9-4Z"/><path d="M12 8v5m0 3h.01"/></svg>
      <span>{{ changing ? '正在更改…' : permissionLabels[mode] }}</span>
    </button>
    <div v-if="open" class="lp-permission-menu" role="menu" aria-label="Codex 权限模式">
      <div class="lp-permission-heading"><span>应如何批准 Codex 操作？</span><a href="https://learn.chatgpt.com/docs/sandboxing" target="_blank" rel="noopener noreferrer">了解更多</a></div>
      <p v-if="!supported" class="lp-permission-note">请更新电脑端和 Cloud，并连接原 Codex 窗口后更改权限。</p>
      <button v-for="option in options" :key="option.value" class="lp-permission-option" :class="{'is-full':option.value === 'full-access'}"
        type="button" role="menuitemradio" :aria-checked="mode === option.value" :disabled="!supported || changing"
        @click="choose(option.value)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path v-if="option.value === 'ask'" d="M8 13V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 5-3 7-7 7-3 0-5-2-6-4l-3-5a1.5 1.5 0 0 1 2-2l2 2Z"/><template v-else><path d="M12 3 21 7v6c0 4-5 7-9 8-4-1-9-4-9-8V7l9-4Z"/><path v-if="option.value === 'full-access'" d="M12 8v5m0 3h.01"/><path v-else d="m8 12 3 3 5-6"/></template></svg>
        <span class="lp-permission-copy"><strong>{{ permissionLabels[option.value] }}</strong><span>{{ option.description }}</span></span>
        <span class="lp-permission-check" aria-hidden="true">{{ mode === option.value ? '✓' : '' }}</span>
      </button>
      <p v-if="running" class="lp-permission-note">更改用于后续任务；当前任务和已发起的审批保留原设置。</p>
      <p v-else-if="mode === 'custom' || mode === 'unknown'" class="lp-permission-note">{{ mode === 'custom' ? '当前会话使用原窗口的自定义权限。选择后会替换为对应模式。' : '电脑端未返回完整权限状态，选择后将重新读取实际设置。' }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { permissionLabels, type PermissionMode, type PermissionPreset } from '../../lanpower/permissions'
const props = defineProps<{mode:PermissionMode;supported:boolean;disabled?:boolean;changing?:boolean;running?:boolean}>()
const emit = defineEmits<{change:[value:PermissionPreset]}>()
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), open = ref(false)
const options: Array<{value:PermissionPreset;description:string}> = [
  {value:'ask',description:'编辑工作区外的文件和使用互联网时请求批准'},
  {value:'auto-review',description:'由 Codex 审核请求，仅需你批准检测到的风险操作'},
  {value:'full-access',description:'可访问互联网和这台电脑上的任何文件'}
]
function close(): void { open.value = false; trigger.value?.focus() }
function choose(value:PermissionPreset): void { close(); if (value !== props.mode) emit('change',value) }
function outside(event:MouseEvent): void { if (!root.value?.contains(event.target as Node)) open.value = false }
watch(() => props.disabled, value => { if (value) open.value = false })
onMounted(() => document.addEventListener('click',outside))
onBeforeUnmount(() => document.removeEventListener('click',outside))
</script>

<style scoped>
.lp-permission-picker{position:relative;flex:0 0 auto;min-width:0}
.lp-permission-trigger{display:flex;align-items:center;gap:.35rem;max-width:10rem;border:0;border-radius:999px;background:var(--lp-surface-soft,#f5f5f5);padding:.45rem .65rem;color:inherit;font-size:.8rem;cursor:pointer}
.lp-permission-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
svg{flex:none;width:1.2rem;height:1.2rem}
.is-full{color:#e8580c}
.lp-permission-trigger:disabled{opacity:.5;cursor:default}
.lp-permission-menu{position:absolute;left:0;bottom:calc(100% + .6rem);z-index:60;width:27rem;max-width:calc(100vw - 3rem);border:1px solid #ddd;border-radius:1.25rem;background:#fff;color:#27272a;padding:.65rem;box-shadow:0 12px 32px #0002}
.lp-permission-heading{display:flex;justify-content:space-between;gap:1rem;padding:.35rem .55rem .5rem;color:#71717a;font-size:.85rem}
.lp-permission-heading a{color:inherit;white-space:nowrap;text-decoration:underline}
.lp-permission-option{display:flex;align-items:center;gap:.75rem;width:100%;border:0;border-radius:.7rem;background:transparent;color:inherit;padding:.7rem .55rem;text-align:left;cursor:pointer}
.lp-permission-option.is-full{color:#e8580c}
.lp-permission-option:hover,.lp-permission-option:focus-visible{background:#f4f4f5}
.lp-permission-option:disabled{opacity:.45;cursor:default}
.lp-permission-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:.2rem}
.lp-permission-copy strong{font-size:.95rem;font-weight:500}
.lp-permission-copy>span,.lp-permission-note{font-size:.8rem;line-height:1.45;color:#71717a}
.is-full .lp-permission-copy>span{color:inherit}
.lp-permission-check{width:1rem;font-size:1.15rem}
.lp-permission-note{margin:.35rem .55rem}
:global(.dark .lp-permission-trigger){background:#27272a}
:global(.dark .lp-permission-menu){background:#18181b;color:#f4f4f5;border-color:#3f3f46}
:global(.dark .lp-permission-option:hover),:global(.dark .lp-permission-option:focus-visible){background:#27272a}
@media(max-width:640px){.lp-permission-trigger{max-width:7.5rem;font-size:.75rem;padding:.4rem .45rem}.lp-permission-menu{left:-2.7rem;width:min(27rem,calc(100vw - 2rem))}.lp-permission-heading{font-size:.78rem}}
</style>
