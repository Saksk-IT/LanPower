<template>
  <div class="lp-files-overlay" @click.self="$emit('close')"><aside class="lp-files-panel" role="dialog" aria-modal="true" aria-label="项目文件">
    <header><div><h2>项目文件</h2><small :title="cwd">{{ projectName }} <span v-if="branch">· {{ branch }}</span></small></div><button class="lp-icon-button" aria-label="关闭项目文件" @click="$emit('close')"><IconTablerX /></button></header>
    <div class="lp-file-breadcrumb"><button @click="openDirectory('.')">{{ projectName }}</button><span v-for="(part,index) in pathParts" :key="index"> / <button @click="openDirectory(pathParts.slice(0,index+1).join('/'))">{{ part }}</button></span></div>
    <div class="lp-file-toolbar"><button v-if="directory !== '.' && directory" class="lp-secondary" @click="openDirectory(parentDirectory)">‹ 上一级</button><input v-model="query" placeholder="搜索项目文件…" aria-label="搜索项目文件" maxlength="256" /></div>
    <p v-if="error" class="lp-panel-error">{{ error }}</p><p v-if="loading" class="lp-section-empty">正在读取…</p>
    <div v-else-if="!selectedFile" class="lp-files-list"><button v-for="file in files" :key="file.path" @click="file.directory ? openDirectory(file.path) : openFile(file.path)"><IconTablerFolder v-if="file.directory" /><span v-else class="lp-file-glyph">▤</span><span>{{ query ? file.path : file.name }}</span><span v-if="file.directory">›</span></button><p v-if="!files.length" class="lp-section-empty">{{ query ? '没有匹配的文件' : '此目录为空' }}</p><button v-if="nextCursor" class="lp-more" @click="loadMore">加载更多</button><p v-if="truncated" class="lp-feature-note">结果较多，可以输入更具体的文件名。</p></div>
    <section v-else class="lp-file-preview"><header><button class="lp-secondary" @click="selectedFile = null">‹ 文件列表</button><button v-if="selectedFile.content !== undefined" class="lp-primary" @click="$emit('attach',absolutePath(selectedFile.path))">添加到聊天</button></header><h3>{{ selectedFile.path }}</h3><p v-if="selectedFile.binary">二进制文件，请在电脑上打开。</p><p v-else-if="selectedFile.tooLarge">文件超过 1 MB，请在电脑上打开完整文件。</p><pre v-else>{{ selectedFile.content }}</pre></section>
  </aside></div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { connection } from '../../lanpower/connection'
import IconTablerFolder from '../icons/IconTablerFolder.vue'
import IconTablerX from '../icons/IconTablerX.vue'
const props = defineProps<{cwd:string;ready:boolean;initialPath?:string}>()
defineEmits<{close:[];attach:[path:string]}>()
const directory = ref('.'), files = ref<any[]>([]), nextCursor = ref(''), branch = ref(''), selectedFile = ref<any>(null), error = ref(''), loading = ref(false), query = ref(''), truncated = ref(false)
const projectName = computed(() => props.cwd.replace(/\\/g,'/').replace(/\/$/,'').split('/').pop() || '项目')
const pathParts = computed(() => directory.value === '.' ? [] : directory.value.replace(/\\/g,'/').split('/'))
const parentDirectory = computed(() => pathParts.value.slice(0,-1).join('/') || '.')
let generation = 0, searchTimer: ReturnType<typeof setTimeout>
async function read(method: string, params: any): Promise<any> { const sequence = ++generation; loading.value = true; error.value = ''; try { const result = await connection.request(method,{cwd:props.cwd,...params}); return sequence === generation ? result : null } catch(failure) { if (sequence === generation) error.value = failure instanceof Error ? failure.message : '读取文件未完成。'; return null } finally { if (sequence === generation) loading.value = false } }
async function openDirectory(path: string): Promise<void> { clearTimeout(searchTimer); query.value = ''; directory.value = path; selectedFile.value = null; const result = await read('lanpower/files/list',{path}); if (!result) return; files.value = result.data || []; nextCursor.value = result.nextCursor || ''; branch.value = result.branch || ''; truncated.value = Boolean(result.truncated) }
async function openFile(path: string): Promise<void> { const result = await read('lanpower/files/read',{path}); if (result) selectedFile.value = result }
async function loadMore(): Promise<void> { if (!nextCursor.value || loading.value) return; const result = await read('lanpower/files/list',{path:directory.value,cursor:nextCursor.value}); if (result) { files.value = [...files.value,...result.data]; nextCursor.value = result.nextCursor || '' } }
function absolutePath(path: string): string { return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ? path : props.cwd.replace(/[\\/]+$/,'') + '/' + path.replace(/\\/g,'/') }
watch(query,(value, previous) => { clearTimeout(searchTimer); if (!value.trim()) { if (previous) void openDirectory(directory.value); return }; selectedFile.value = null; searchTimer = setTimeout(async () => { const result = await read('lanpower/files/search',{query:value.trim()}); if (result) { files.value = result.data || []; nextCursor.value = ''; truncated.value = Boolean(result.truncated) } },300) })
if (props.ready) props.initialPath ? void openFile(props.initialPath) : void openDirectory('.')
onBeforeUnmount(() => { generation++; clearTimeout(searchTimer) })
</script>
