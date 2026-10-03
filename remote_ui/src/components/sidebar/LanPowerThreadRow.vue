<template>
  <SidebarMenuRow as="div" class="lp-thread" :class="{ selected }" :data-thread-id="thread.id" @click="$emit('select')" @contextmenu.prevent="$emit('menu', $event)">
    <template #left><span v-if="working" class="lp-thread-spinner" aria-label="正在工作" /><span v-else-if="pending" class="lp-thread-attention" aria-label="等待回复" /><span v-else class="lp-thread-spacer" /></template>
    <button class="lp-thread-title" :title="thread.title">{{ thread.title }}</button>
    <template #right><small class="lp-thread-time">{{ relativeTime }}</small></template><template #right-hover><button class="lp-icon-button" :aria-label="`管理聊天 ${thread.title}`" @click.stop="$emit('menu', $event)"><IconTablerDots /></button></template>
  </SidebarMenuRow>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import SidebarMenuRow from './SidebarMenuRow.vue'
import IconTablerDots from '../icons/IconTablerDots.vue'
import type { LibraryThread } from '../../lanpower/library'
const props = defineProps<{ thread: LibraryThread; selected: boolean; working: boolean; pending: boolean }>()
defineEmits<{ select: []; menu: [event: MouseEvent] }>()
const relativeTime = computed(() => { const age = Math.max(0, Date.now()/1000 - props.thread.updatedAt); return age < 60 ? '刚刚' : age < 3600 ? `${Math.floor(age/60)}m` : age < 86400 ? `${Math.floor(age/3600)}h` : age < 7*86400 ? `${Math.floor(age/86400)}d` : new Date(props.thread.updatedAt*1000).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}) })
</script>
