<template>
  <main class="lp-feature-page lp-conversation">
    <header class="lp-chat-header"><button class="lp-back" aria-label="返回会话列表" @click="$emit('back')"><IconTablerLayoutSidebar /></button><div><h1>{{ view === 'skills' ? '技能' : view === 'automations' ? '自动化' : '设置' }}</h1></div><button class="lp-icon-button" aria-label="返回聊天" @click="$emit('close')"><IconTablerX /></button></header>
    <div class="lp-feature-content">
      <template v-if="view === 'settings'">
        <h2>让工作更顺手</h2><p class="lp-feature-intro">调整此浏览器的阅读和输入偏好。</p>
        <section class="lp-settings-card lp-native-status"><h3>额度与上下文</h3><button class="lp-secondary" :disabled="!ready || quota.loading" @click="$emit('refresh-quota')">刷新原生额度</button><RateLimitStatus :snapshots="quota.snapshots" :loading="quota.loading" :unavailable-reason="quota.reason" /><TokenUsageStatus :usage="context.usage" :reason="context.reason" /></section>
        <section class="lp-settings-card"><h3>外观</h3><div class="lp-segmented" role="group" aria-label="外观"><button v-for="mode in themes" :key="mode.value" :class="{active:theme === mode.value}" @click="theme = mode.value; $emit('theme', mode.value)">{{ mode.label }}</button></div></section>
        <section class="lp-settings-card"><h3>发送消息</h3><label class="lp-setting-row"><span>按 Enter 发送<small>关闭后使用 Ctrl / ⌘ + Enter 发送。</small></span><input type="checkbox" :checked="sendWithEnter" @change="$emit('update:send-with-enter',($event.target as HTMLInputElement).checked)" /></label><label class="lp-setting-row"><span>任务运行时发送为</span><ComposerDropdown :model-value="inProgressMode" :options="[{value:'queue',label:'加入队列'},{value:'steer',label:'引导当前任务'}]" @update:model-value="$emit('update:in-progress-mode',$event as 'queue'|'steer')" /></label></section>
        <section class="lp-settings-card"><h3>电脑和授权</h3><p>项目与操作权限由电脑上的 LanPower 管理。</p><a href="/dashboard">返回 LanPower 管理电脑</a></section>
        <p class="lp-feature-note">LanPower {{ version }} · 对话来自原 Codex 窗口</p>
      </template>
      <template v-else>
        <h2>{{ view === 'skills' ? '为工作添加能力' : '按计划继续工作' }}</h2>
        <p class="lp-feature-intro">{{ view === 'skills' ? '从原窗口读取技能、插件、应用和 MCP 服务。' : '查看原 Codex 桌面中已配置的自动化。' }}</p>
        <div v-if="view === 'skills'" class="lp-segmented lp-directory-tabs" role="tablist" aria-label="能力目录"><button v-for="tab in directoryTabs" :key="tab.value" role="tab" :aria-selected="directoryKind === tab.value" :class="{active:directoryKind === tab.value}" @click="directoryKind = tab.value">{{ tab.label }}</button></div>
        <div class="lp-feature-toolbar"><input v-model="query" class="lp-feature-search" :placeholder="view === 'skills' ? '搜索本页能力…' : '搜索自动化…'" aria-label="搜索" /><button class="lp-secondary" :disabled="loading || !ready" @click="load">{{ loading ? '正在读取…' : '刷新' }}</button></div>
        <div v-if="view === 'skills' && (directoryKind === 'skill' || directoryKind === 'plugin') && projects.length" class="lp-feature-project"><span>项目</span><ComposerDropdown v-model="selectedCwd" :options="projects.filter(p => p.kind !== 'chat').map(p => ({value:p.path,label:p.name}))" enable-search placeholder="选择项目" /></div>
        <p v-if="error" class="lp-panel-error" role="status">{{ error }}</p>
        <p v-if="!ready" class="lp-feature-empty">连接开发电脑后读取。</p>
        <p v-else-if="loading && !rows.length" class="lp-feature-empty">正在读取原窗口…</p>
        <div v-else-if="filteredRows.length" class="lp-feature-grid">
          <article v-for="row in filteredRows" :key="row.path || row.id" class="lp-feature-card">
            <div class="lp-card-heading"><span class="lp-card-icon"><IconTablerBolt /></span><span class="lp-card-badge" :data-state="view === 'skills' ? capabilityStatus(directoryKind,row).state : ''">{{ view === 'skills' ? capabilityStatus(directoryKind,row).label : row.status === 'PAUSED' ? '已暂停' : '启用中' }}</span></div>
            <h3>{{ row.displayName || row.interface?.displayName || row.name || row.id }}</h3><p v-if="view === 'skills'">{{ row.description || row.interface?.shortDescription || '原生目录未提供说明。' }}</p><p v-else>{{ scheduleLabel(row.rrule) }}</p>
            <p v-if="view === 'skills'" class="lp-native-reason">{{ capabilityStatus(directoryKind,row).reason }}</p>
            <footer v-if="view === 'skills'"><button class="lp-secondary" @click="details = row">详情</button><button v-if="directoryKind === 'skill'" class="lp-primary" :disabled="row.enabled !== true" @click="$emit('use-skill',row)">添加到聊天</button></footer><p v-else class="lp-card-cwd">{{ row.cwds?.map((cwd:string) => cwd.replace(/\\/g,'/').split('/').pop()).join(' · ') }}</p>
          </article>
        </div>
        <div v-else-if="!error" class="lp-feature-empty"><IconTablerBolt /><h3>{{ view === 'skills' ? `没有匹配的${directoryTabs.find(t => t.value === directoryKind)?.label}` : '没有匹配的自动化' }}</h3><p>{{ query ? '试试其他关键词。' : view === 'skills' ? '在原桌面添加后，点击刷新。' : '在原 Codex 桌面创建自动化后，点击刷新。' }}</p></div>
        <nav v-if="view === 'skills'" class="lp-catalog-pagination" aria-label="能力目录分页"><span>第 {{ catalogState.page }} 页 · 搜索仅针对当前页</span><div><button class="lp-secondary" :disabled="loading || !ready || catalogState.page <= 1" @click="catalog.previous()">上一页</button><button class="lp-secondary" :disabled="loading || !ready || !catalogState.nextCursor" @click="catalog.next()">下一页</button></div></nav>
        <p v-if="view === 'skills' && directoryKind !== 'skill'" class="lp-feature-note">安装、授权和连接设置在原 Codex 桌面管理。<button v-if="directoryKind === 'mcp'" class="lp-secondary" :disabled="loading || !ready" @click="reloadMcp">重新加载 MCP 服务</button></p>
        <p v-if="view === 'automations'" class="lp-feature-note">创建、编辑和调度在原 Codex 桌面管理；此处显示已授权项目的实际配置。</p>
      </template>
    </div>
    <Teleport to="body"><div v-if="details" class="lp-dialog-overlay" @click.self="details = null"><section class="lp-dialog lp-skill-details" role="dialog" aria-modal="true" aria-label="能力详情"><h2>{{ details.displayName || details.name }}</h2><p>{{ details.description }}</p><small>{{ details.path }}</small><ul v-if="details.tools"><li v-for="tool in details.tools" :key="tool.name"><strong>{{ tool.title || tool.name }}</strong><p>{{ tool.description }}</p></li></ul><footer><button @click="details = null">关闭</button><button v-if="directoryKind === 'skill'" class="lp-primary" :disabled="details.enabled !== true" @click="$emit('use-skill',details); details = null">添加到聊天</button></footer></section></div></Teleport>
  </main>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { connection } from '../../lanpower/connection'
import ComposerDropdown from './ComposerDropdown.vue'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerLayoutSidebar from '../icons/IconTablerLayoutSidebar.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import RateLimitStatus from './RateLimitStatus.vue'
import TokenUsageStatus from './TokenUsageStatus.vue'
import { NativeDirectory, capabilityStatus } from '../../lanpower/nativeStatus'
const props = defineProps<{view:string;ready:boolean;projects:Array<{name:string;path:string;kind?:string}>;cwd:string;sendWithEnter:boolean;inProgressMode:'queue'|'steer';quota:any;context:any;capabilityPaging:boolean}>()
defineEmits<{back:[];close:[];'use-skill':[skill:any];theme:[mode:string];'refresh-quota':[];'update:send-with-enter':[value:boolean];'update:in-progress-mode':[mode:'queue'|'steer']}>()
const query = ref(''), details = ref<any>(null), selectedCwd = ref(props.cwd)
const catalogState = shallowRef<any>({rows:[],loading:false,error:'',page:1,nextCursor:''})
const catalog = new NativeDirectory(connection, () => props.ready, () => { catalogState.value = {...catalog.state} }, () => props.capabilityPaging)
const rows = computed<any[]>(() => catalogState.value.rows), loading = computed(() => catalogState.value.loading), error = computed(() => catalogState.value.error)
const directoryKind = ref('skill'), directoryTabs = [{value:'skill',label:'技能'},{value:'plugin',label:'插件'},{value:'app',label:'应用'},{value:'mcp',label:'MCP'}]
const themes = [{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}], theme = ref(document.documentElement.classList.contains('dark') ? 'dark' : 'light'), version = import.meta.env.VITE_APP_VERSION
const filteredRows = computed(() => rows.value.filter(row => `${row.name} ${row.displayName || ''} ${row.description || ''}`.toLowerCase().includes(query.value.toLowerCase())))
async function load(): Promise<void> {
  if (!props.ready || props.view === 'settings') { catalog.reset(); catalogState.value = {...catalog.state}; return }
  await catalog.load(props.view === 'skills' ? directoryKind.value : 'automations',selectedCwd.value,'',1,true)
}
async function reloadMcp(): Promise<void> { try { await connection.request('config/mcpServer/reload'); await load() } catch(failure) { catalogState.value = {...catalogState.value,error:failure instanceof Error ? failure.message : '加载未完成。'} } }
function scopeLabel(scope: string): string { return ({system:'系统',repo:'项目',user:'个人',plugin:'插件'} as Record<string,string>)[scope] || '技能' }
function scheduleLabel(rrule: string): string { const hour = rrule?.match(/BYHOUR=(\d+)/)?.[1], minute = rrule?.match(/BYMINUTE=(\d+)/)?.[1]; return rrule?.includes('FREQ=DAILY') && hour ? `每天 ${hour.padStart(2,'0')}:${(minute || '0').padStart(2,'0')}` : rrule?.includes('FREQ=HOURLY') ? `每 ${rrule.match(/INTERVAL=(\d+)/)?.[1] || '1'} 小时` : '已设置计划' }
watch(() => props.cwd, cwd => { selectedCwd.value = cwd })
watch([() => props.view,() => props.ready,() => props.capabilityPaging,selectedCwd,directoryKind],() => { details.value = null; void load() },{immediate:true})
onBeforeUnmount(() => catalog.reset())
</script>
