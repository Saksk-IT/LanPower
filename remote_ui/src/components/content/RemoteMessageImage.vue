<template>
  <button ref="element" class="message-image-button lp-remote-image" :class="{ 'lp-image-thumbnail': thumbnail }" type="button" :aria-label="`查看${alt || '图片'}`" @click="open">
    <img v-if="url" class="message-image-preview" :class="imageClass" :src="url" :alt="alt || '图片'" loading="lazy" @error="error = '图片加载失败，点击重试。'; url = ''" />
    <span v-else class="lp-image-placeholder" role="status">{{ error || '正在读取图片…' }}</span>
  </button>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolveRemoteImage } from '../../lanpower/images'
const props = withDefaults(defineProps<{source:string;threadId:string;cwd:string;alt?:string;imageClass?:string;thumbnail?:boolean}>(), {thumbnail:true})
const emit = defineEmits<{open:[url:string]}>()
const element = ref<HTMLElement | null>(null), url = ref(''), error = ref('')
let generation = 0, observer: IntersectionObserver | undefined, visible = false, pending: Promise<void> | undefined
function load(): Promise<void> {
  if (pending) return pending
  const sequence = ++generation; error.value = ''
  pending = resolveRemoteImage(props.source,props.threadId,props.cwd).then(value => { if (sequence === generation) url.value = value }).catch(failure => { if (sequence === generation) error.value = failure instanceof Error ? failure.message : '读取图片失败，点击重试。' }).finally(() => { if (sequence === generation) pending = undefined })
  return pending
}
async function open(): Promise<void> { if (!url.value) await load(); if (url.value) emit('open',url.value) }
watch(() => [props.source,props.threadId,props.cwd],() => { generation++; pending = undefined; url.value = ''; error.value = ''; if (visible) void load() })
onMounted(() => { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible = true; observer?.disconnect(); void load() } },{rootMargin:'200px'}); if (element.value) observer.observe(element.value) })
onBeforeUnmount(() => { generation++; observer?.disconnect() })
</script>
<style scoped>
.lp-remote-image { display: block; max-width: 100%; padding: 0; overflow: hidden; border: 1px solid var(--lp-border,#e5e5e5); border-radius: 12px; background: var(--lp-surface,#fff); cursor: zoom-in; }
.lp-remote-image:hover { border-color: var(--lp-muted,#737373); }
.message-image-preview { display: block; width: auto; height: auto; max-width: min(560px,100%); max-height: min(460px,62vh); object-fit: contain; }
.lp-image-thumbnail { width: 104px; height: 104px; flex-shrink: 0; }
.lp-image-thumbnail .message-image-preview { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: cover; }
.lp-image-placeholder { display: flex; align-items: center; justify-content: center; min-height: 80px; padding: 12px; color: var(--lp-muted,#737373); font-size: 12px; overflow-wrap: anywhere; }
.lp-image-thumbnail .lp-image-placeholder { width: 100%; height: 100%; }
@media (max-width:640px) { .lp-image-thumbnail { width: 88px; height: 88px; } }
</style>
