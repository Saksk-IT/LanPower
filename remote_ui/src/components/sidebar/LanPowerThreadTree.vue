<template>
  <div class="lp-sidebar" :class="{ 'chats-first': preferences.chatsFirst }">
    <div class="lp-sidebar-toolbar">
      <SidebarThreadControls :is-sidebar-collapsed="false" :show-new-thread-button="true" @toggle-sidebar="$emit('toggle-sidebar')" @start-new-thread="$emit('new-thread')">
        <button class="sidebar-thread-controls-button" :aria-pressed="searchVisible" aria-label="搜索聊天和项目" @click="searchVisible = !searchVisible"><IconTablerSearch /></button>
      </SidebarThreadControls>
      <a href="/dashboard" class="lp-home" aria-label="返回 LanPower">LanPower</a>
    </div>
    <div class="lp-sidebar-scrollable">
      <div v-if="searchVisible" class="lp-sidebar-search"><IconTablerSearch /><input v-model="query" class="lp-search" placeholder="搜索聊天和项目…" aria-label="搜索聊天和项目" maxlength="120" /><button v-if="query" @click="query = ''" aria-label="清除搜索">×</button></div>
      <slot name="connection" />
      <button class="lp-feature-link" @click="$emit('navigate', 'skills')"><span class="lp-feature-icon"><IconTablerBolt /></span><span><strong>技能</strong><small>PLUGINS, APPS, MCPS</small></span></button>
      <button class="lp-feature-link" @click="$emit('navigate', 'automations')"><span class="lp-feature-icon lp-automations-icon"><IconTablerBolt /></span><span><strong>自动化</strong><small>SCHEDULED WORK</small></span></button>
      <section v-if="library.pinned.length" class="lp-library-section lp-pinned-section">
        <SidebarMenuRow as="button" class="lp-section-toggle" :aria-expanded="expanded('pinned')" @click="toggleSection('pinned')"><template #left><IconTablerChevronDown v-if="expanded('pinned')" /><IconTablerChevronRight v-else /></template>已置顶</SidebarMenuRow>
        <div v-if="expanded('pinned')"><ThreadRow v-for="thread in library.pinned" :key="thread.id" :thread="thread" :selected="selectedThreadId === thread.id" :working="Boolean(activeTurns[thread.id])" :pending="approvalThreads.includes(thread.id)" @select="$emit('select', thread.id)" @menu="openMenu($event, 'thread', thread.id)" /></div>
      </section>
      <section class="lp-library-section lp-projects-section">
        <SidebarMenuRow as="div" class="lp-section-toggle"><template #left><button @click="toggleSection('projects')" :aria-expanded="expanded('projects')" aria-label="展开或收起项目"><IconTablerChevronDown v-if="expanded('projects')" /><IconTablerChevronRight v-else /></button></template><button class="lp-section-name" @click="toggleSection('projects')" :aria-expanded="expanded('projects')">项目</button><template #right><button class="lp-icon-button" aria-label="整理项目和聊天" @click="openMenu($event, 'organize', '')"><IconTablerDots /></button></template></SidebarMenuRow>
        <div v-if="expanded('projects')" class="lp-project-groups">
          <article v-for="group in library.projects" :key="group.id" class="lp-project" :data-project-path="group.path" :data-expanded="!collapsed(group.id)">
            <SidebarMenuRow as="div" class="lp-project-header" @contextmenu.prevent="openMenu($event, 'project', group.id)" @dragover.prevent @drop.prevent="dropProject(group.id)">
              <template #left><button class="lp-folder-toggle" :aria-label="`${collapsed(group.id) ? '展开' : '收起'}项目 ${group.name}`" :aria-expanded="!collapsed(group.id)" @click="toggleProject(group.id)"><IconTablerFolder v-if="collapsed(group.id)" /><IconTablerFolderOpen v-else /></button></template>
              <button class="lp-project-title" :title="group.path" :aria-expanded="!collapsed(group.id)" draggable="true" @dragstart="draggedProject = group.id" @dragend="draggedProject = ''" @click="toggleProject(group.id)">{{ group.name }}</button>
              <template #right><div class="lp-project-controls"><button class="lp-icon-button" :aria-label="`管理项目 ${group.name}`" @click="openMenu($event, 'project', group.id)"><IconTablerDots /></button><button class="lp-icon-button" :disabled="!ready" :aria-label="`在 ${group.name} 新建聊天`" @click="$emit('new-thread', group.path)"><IconTablerFilePencil /></button></div></template>
            </SidebarMenuRow>
            <div v-if="!collapsed(group.id)">
              <ThreadRow v-for="thread in visibleThreads(group)" :key="thread.id" :thread="thread" :selected="selectedThreadId === thread.id" :working="Boolean(activeTurns[thread.id])" :pending="approvalThreads.includes(thread.id)" @select="$emit('select', thread.id)" @menu="openMenu($event, 'thread', thread.id)" />
              <button v-if="group.threads.length > 10 && !query" class="lp-more" @click="expandedGroups[group.id] = !expandedGroups[group.id]">{{ expandedGroups[group.id] ? '收起聊天' : `显示更多（${group.threads.length - 10}）` }}</button>
              <p v-if="!group.threads.length" class="lp-section-empty">{{ query ? '没有匹配的聊天' : '还没有聊天' }}</p>
            </div>
          </article>
          <p v-if="!library.projects.length" class="lp-section-empty">{{ loading ? '正在读取项目…' : query ? '没有匹配的项目' : '暂无项目' }}</p>
        </div>
      </section>
      <section class="lp-library-section lp-chats-section">
        <SidebarMenuRow as="div" class="lp-section-toggle"><template #left><button @click="toggleSection('chats')" :aria-expanded="expanded('chats')" aria-label="展开或收起聊天"><IconTablerChevronDown v-if="expanded('chats')" /><IconTablerChevronRight v-else /></button></template><button class="lp-section-name" @click="toggleSection('chats')" :aria-expanded="expanded('chats')">聊天</button><template #right><button class="lp-icon-button" :disabled="!ready || !chatSupported" aria-label="新建独立聊天" @click="$emit('new-chat')"><IconTablerFilePencil /></button></template></SidebarMenuRow>
        <div v-if="expanded('chats')"><ThreadRow v-for="thread in library.chats" :key="thread.id" :thread="thread" :selected="selectedThreadId === thread.id" :working="Boolean(activeTurns[thread.id])" :pending="approvalThreads.includes(thread.id)" @select="$emit('select', thread.id)" @menu="openMenu($event, 'thread', thread.id)" /><p v-if="!library.chats.length" class="lp-section-empty">{{ query ? '没有匹配的聊天' : '没有独立聊天' }}</p></div>
      </section>
      <button v-if="nextCursor" class="lp-more lp-load-threads" :disabled="loading" @click="$emit('load-more')">{{ loading ? '正在读取…' : '加载更早的聊天' }}</button>
      <button class="lp-archive-view" :aria-pressed="archived" @click="$emit('toggle-archived')">{{ archived ? '‹ 返回最近聊天' : '查看已归档聊天' }}</button>
    </div>
    <footer class="lp-sidebar-footer"><button @click="$emit('navigate', 'settings')"><IconTablerSettings /><span>设置</span></button><span>LanPower {{ version }}</span></footer>
    <Teleport to="body">
      <div v-if="menu" class="lp-menu-backdrop" @click="menu = null" @contextmenu.prevent="menu = null">
        <div class="lp-context-menu" role="menu" :style="menuStyle" @click.stop @keydown.esc="menu = null">
          <template v-if="menu.type === 'organize'">
            <small>整理</small><button role="menuitem" @click="preferences.chatsFirst = !preferences.chatsFirst">聊天优先 <span>{{ preferences.chatsFirst ? '✓' : '' }}</span></button>
            <button role="menuitem" @click="preferences.collapsed = []">展开所有项目</button><button role="menuitem" @click="preferences.collapsed = library.projects.map(p => p.id)">收起所有项目</button>
            <hr /><small>排序</small><button role="menuitemradio" :aria-checked="preferences.sort === 'updated'" @click="preferences.sort = 'updated'">更新时间 <span>{{ preferences.sort === 'updated' ? '✓' : '' }}</span></button><button role="menuitemradio" :aria-checked="preferences.sort === 'created'" @click="preferences.sort = 'created'">创建时间 <span>{{ preferences.sort === 'created' ? '✓' : '' }}</span></button>
            <button v-if="preferences.hidden.length" role="menuitem" @click="preferences.hidden = []; menu = null">显示已收纳的项目（{{ preferences.hidden.length }}）</button>
          </template>
          <template v-else-if="menu.type === 'project'">
            <button role="menuitem" @click="projectAction('new')">新建聊天</button><button role="menuitem" @click="projectAction('files')">浏览项目文件</button><button role="menuitem" @click="renameProject">重命名显示名称</button><button role="menuitem" @click="moveProject(-1)">向上移动</button><button role="menuitem" @click="moveProject(1)">向下移动</button><hr /><button role="menuitem" @click="hideProject">收纳项目</button>
          </template>
          <template v-else>
            <button role="menuitem" @click="pinThread">{{ preferences.pinned.includes(menu.id) ? '取消置顶' : '置顶聊天' }}</button><button role="menuitem" @click="threadAction('rename')">重命名</button><button role="menuitem" @click="threadAction('fork')">分支聊天</button><button role="menuitem" @click="threadAction('export')">导出完整聊天</button><hr /><button role="menuitem" @click="threadAction(archived ? 'unarchive' : 'archive')">{{ archived ? '恢复聊天' : '归档聊天' }}</button>
          </template>
        </div>
      </div>
      <div v-if="renameTarget" class="lp-dialog-overlay" @click.self="renameTarget = null"><form class="lp-dialog" role="dialog" aria-modal="true" aria-label="重命名项目" @submit.prevent="saveProjectName"><h2>重命名项目</h2><p>调整侧栏中的显示名称。</p><input v-model="renameDraft" aria-label="项目显示名称" autofocus maxlength="120" /><footer><button type="button" @click="renameTarget = null">取消</button><button type="submit" class="lp-primary">保存</button></footer></form></div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import SidebarMenuRow from './SidebarMenuRow.vue'
import SidebarThreadControls from './SidebarThreadControls.vue'
import ThreadRow from './LanPowerThreadRow.vue'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerDots from '../icons/IconTablerDots.vue'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerFolderOpen from '../icons/IconTablerFolderOpen.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerSettings from '../icons/IconTablerSettings.vue'
import { buildLibrary, defaultLibraryPreferences, libraryThread, type LibraryGroup, type LibraryPreferences, type LibraryProject } from '../../lanpower/library'
const props = defineProps<{ deviceId: string; projects: LibraryProject[]; threads: any[]; selectedThreadId: string; activeTurns: Record<string,string>; approvalThreads: string[]; ready: boolean; loading: boolean; nextCursor: string; archived: boolean; chatSupported: boolean; savedPreferences: LibraryPreferences }>()
const emit = defineEmits<{ select: [id: string]; 'new-thread': [cwd?: string]; 'new-chat': []; 'load-more': []; 'toggle-sidebar': []; 'toggle-archived': []; navigate: [view: string]; 'thread-action': [action: string, id: string]; 'browse-files': [cwd: string]; 'update-library': [preferences: LibraryPreferences] }>()
const version = import.meta.env.VITE_APP_VERSION
const preferences = ref<LibraryPreferences>(defaultLibraryPreferences()), query = ref(''), searchVisible = ref(false), expandedGroups = ref<Record<string,boolean>>({}), draggedProject = ref('')
const menu = ref<{ type: string; id: string; x: number; y: number } | null>(null), renameTarget = ref<LibraryGroup | null>(null), renameDraft = ref('')
const library = computed(() => buildLibrary(props.projects, props.threads.map(libraryThread), preferences.value, query.value))
const menuStyle = computed(() => menu.value ? { left: `${Math.max(8, Math.min(menu.value.x, innerWidth - 244))}px`, top: `${Math.max(8, Math.min(menu.value.y, innerHeight - 320))}px` } : {})
watch(() => props.deviceId, () => {
  preferences.value = defaultLibraryPreferences(); menu.value = null; query.value = ''; expandedGroups.value = {}
}, { immediate: true })
watch(() => props.savedPreferences, value => { if (JSON.stringify(value) !== JSON.stringify(preferences.value)) preferences.value = JSON.parse(JSON.stringify(value)) }, { deep: true, immediate: true })
watch(preferences, value => { if (props.deviceId && props.ready && JSON.stringify(value) !== JSON.stringify(props.savedPreferences)) emit('update-library',JSON.parse(JSON.stringify(value))) }, { deep: true, flush: 'post' })
function expanded(section: string): boolean { return preferences.value.sections[section] !== false }
function toggleSection(section: string): void { preferences.value.sections[section] = !expanded(section) }
function collapsed(id: string): boolean { return !query.value && preferences.value.collapsed.includes(id) }
function toggleProject(id: string): void { preferences.value.collapsed = preferences.value.collapsed.includes(id) ? preferences.value.collapsed.filter(p => p !== id) : [...preferences.value.collapsed, id] }
function visibleThreads(group: LibraryGroup) { if (query.value || expandedGroups.value[group.id]) return group.threads; const rows = group.threads.slice(0,10); const selected = group.threads.find(t => t.id === props.selectedThreadId); return selected && !rows.includes(selected) ? [...rows, selected] : rows }
function openMenu(event: MouseEvent, type: string, id: string): void { const box = (event.currentTarget as HTMLElement)?.getBoundingClientRect(); menu.value = { type, id, x: event.type === 'contextmenu' ? event.clientX : (box?.left || 8), y: event.type === 'contextmenu' ? event.clientY : (box?.bottom || 8) } }
function threadAction(action: string): void { if (menu.value) emit('thread-action', action, menu.value.id); menu.value = null }
function pinThread(): void { if (!menu.value) return; const id = menu.value.id; preferences.value.pinned = preferences.value.pinned.includes(id) ? preferences.value.pinned.filter(i => i !== id) : [...preferences.value.pinned,id]; menu.value = null }
function selectedProject(): LibraryGroup | undefined { return library.value.projects.find(p => p.id === menu.value?.id) }
function projectAction(action: string): void { const p = selectedProject(); if (p) action === 'new' ? emit('new-thread', p.path) : emit('browse-files', p.path); menu.value = null }
function renameProject(): void { const p = selectedProject(); if (p) { renameTarget.value = p; renameDraft.value = p.name }; menu.value = null }
function saveProjectName(): void { if (renameTarget.value && renameDraft.value.trim()) { preferences.value.aliases[renameTarget.value.id] = renameDraft.value.trim(); renameTarget.value = null } }
function hideProject(): void { if (menu.value) preferences.value.hidden = [...new Set([...preferences.value.hidden,menu.value.id])]; menu.value = null }
function moveProject(direction: number): void { if (!menu.value) return; const order = library.value.projects.map(p => p.id), index = order.indexOf(menu.value.id), target = index + direction; if (target >= 0 && target < order.length) { const id = order.splice(index,1)[0]!; order.splice(target,0,id); preferences.value.order = order }; menu.value = null }
function dropProject(id: string): void { if (!draggedProject.value || draggedProject.value === id) return; const order = library.value.projects.map(p => p.id), from = order.indexOf(draggedProject.value), to = order.indexOf(id); if (from >= 0 && to >= 0) { order.splice(from,1); order.splice(to,0,draggedProject.value); preferences.value.order = order }; draggedProject.value = '' }
function escape(event: KeyboardEvent): void { if (event.key === 'Escape') { menu.value = null; renameTarget.value = null } }
window.addEventListener('keydown', escape)
onBeforeUnmount(() => window.removeEventListener('keydown', escape))
</script>
