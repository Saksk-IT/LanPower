<template>
  <button ref="element" class="message-image-button lp-remote-image" type="button" :aria-label="alt || '查看图片'" @click="open">
    <img v-if="url" class="message-image-preview" :class="imageClass" :src="url" :alt="alt || '图片'" loading="lazy" @error="error = '图片加载失败，点击重试。'; url = ''" />
    <span v-else class="lp-image-placeholder" role="status">{{ error || '正在读取图片…' }}</span>
  </button>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolveRemoteImage } from '../../lanpower/images'
const props = defineProps<{source:string;threadId:string;cwd:string;alt?:string;imageClass?:string}>()
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
