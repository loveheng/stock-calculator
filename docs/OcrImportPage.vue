<template>
  <div class="ocr-import-page">
    <!-- 顶部说明卡片 -->
    <el-card shadow="never" class="guide-card">
      <template #header>
        <div class="card-header">
          <span class="title">证券交割单智能识别与导入</span>
          <el-tag size="small" type="info" effect="plain">OCR 解析 · 30s 超时</el-tag>
        </div>
      </template>
      <el-alert type="info" :closable="false" show-icon>
        <template #title>
          支持暗黑 / 浅色模式截图识别；建议截取手机单屏 1~5 笔成交流水，避免滚动长图与多图拼接导致数字遗漏。
        </template>
      </el-alert>
    </el-card>

    <!-- 常驻错误提示条 -->
    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      closable
      @close="errorMessage = ''"
    />

    <!-- 上传拖拽区（原生 HTML5 Drag & Drop，完全绕过 el-upload） -->
    <el-card shadow="never" class="upload-card">
      <div
        class="custom-drop-zone"
        :class="{ 'drag-over': isDragOver, 'is-disabled': loading }"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
        @click="triggerFileInput"
      >
        <!-- Loading 状态 -->
        <div v-if="loading" class="drop-loading">
          <el-icon class="loading-icon" :size="28"><Loading /></el-icon>
          <span class="loading-text">正在智能提取交割单明细，请稍候...</span>
        </div>
        <!-- 初始状态 -->
        <div v-else class="drop-content">
          <el-icon class="upload-icon"><UploadFilled /></el-icon>
          <div class="upload-title">点击或将截图拖拽到此处</div>
          <div class="upload-hint">支持单屏截图智能识别（深色 / 浅色模式均可）</div>
          <div class="upload-hint">JPG / PNG / WEBP · 10KB ~ 10MB · 单屏截图</div>
        </div>
      </div>
      <!-- 隐藏的文件输入（点击触发） -->
      <input
        ref="fileInputRef"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style="display: none"
        @change="onFileSelect"
      />
    </el-card>

    <!-- 识别结果表格 -->
    <transition name="fade-slide" mode="out-in">
      <el-card v-if="tableData.length > 0" ref="resultCardRef" shadow="never" class="result-card">
        <template #header>
          <div class="card-header">
            <span class="title">识别结果核对</span>
            <el-tag size="small" type="success" effect="plain">共 {{ tableData.length }} 笔</el-tag>
          </div>
        </template>
        <el-table :data="tableData" stripe border size="default" class="result-table">
          <el-table-column label="股票代码" width="110">
            <template #default="{ row, $index }">
              <el-input v-if="editingIndex === $index" v-model="editForm.stockCode" size="small" maxlength="6" placeholder="6位代码" />
              <span v-else class="code-text">{{ row.stockCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="标的名称" min-width="120">
            <template #default="{ row, $index }">
              <el-input v-if="editingIndex === $index" v-model="editForm.stockName" size="small" placeholder="标的名称" />
              <span v-else class="name-text">{{ row.stockName || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="买卖方向" width="100" align="center">
            <template #default="{ row, $index }">
              <el-select v-if="editingIndex === $index" v-model="editForm.direction" size="small" style="width: 84px">
                <el-option label="买入" value="BUY" />
                <el-option label="卖出" value="SELL" />
              </el-select>
              <el-tag v-else :type="row.direction === 'BUY' ? 'danger' : 'success'" size="small" effect="dark">
                {{ row.direction === 'BUY' ? '买入' : '卖出' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="成交价格" width="120" align="right">
            <template #default="{ row, $index }">
              <el-input-number v-if="editingIndex === $index" v-model="editForm.price" size="small" :precision="3" :step="0.01" :min="0.001" :controls="false" style="width: 100px" />
              <span v-else>¥ {{ fmtPrice(row.price) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="成交数量" width="130" align="right">
            <template #default="{ row, $index }">
              <el-input-number v-if="editingIndex === $index" v-model="editForm.volume" size="small" :precision="0" :step="100" :min="1" :controls="false" style="width: 100px" />
              <span v-else>{{ fmtVolume(row.volume) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="成交时间" width="170" align="center">
            <template #default="{ row }"><span>{{ fmtTime(row.tradeTime) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small" effect="plain">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" align="center">
            <template #default="{ $index }">
              <template v-if="editingIndex === $index">
                <el-button type="success" link size="small" @click="saveEdit($index)"><el-icon><Check /></el-icon>保存</el-button>
                <el-button link size="small" @click="cancelEdit"><el-icon><Close /></el-icon>取消</el-button>
              </template>
              <template v-else>
                <el-button type="primary" link size="small" @click="startEdit($index)"><el-icon><Edit /></el-icon>修正</el-button>
                <el-button type="danger" link size="small" @click="removeRow($index)"><el-icon><Delete /></el-icon>删除</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <div class="result-footer">
          <el-button type="primary" :loading="loading" :disabled="loading" @click="handleConfirm">确认入库</el-button>
          <el-button :disabled="loading" @click="handleReset">重新上传</el-button>
        </div>
      </el-card>
      <el-card v-else-if="hasSearched" shadow="never" class="result-card">
        <el-empty description="未从截图中识别到有效已成交流水，请检查截图">
          <el-button type="primary" @click="handleReset">重新上传</el-button>
        </el-empty>
      </el-card>
    </transition>
  </div>
</template>

<script setup lang="ts">
/**
 * 证券交割单截图智能识别与导入页面组件
 *
 * 修复记录 v2.0 — 彻底移除 el-upload 的拖拽功能，改用原生 HTML5 Drag & Drop。
 *   - el-upload 的 drag 模式在部分版本/环境下存在钩子不触发的问题
 *   - 原生事件 (dragover/dragleave/drop) 完全可控，不受 accept/auto-upload/show-file-list 影响
 *   - 点击选择文件使用隐藏的 <input type="file">，与拖拽入口分离
 */
import { nextTick, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import { UploadFilled, Edit, Delete, Check, Close, Loading } from '@element-plus/icons-vue'

// ============================================================
// 类型定义
// ============================================================
interface ApiResponse<T> { code: number; message: string; data: T }
type TradeDirection = 'BUY' | 'SELL'
type TradeStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED'
interface TradeDraftItem {
  stockCode: string
  stockName: string
  direction: TradeDirection
  price: number
  volume: number
  tradeTime: string
  status: TradeStatus
}

// ============================================================
// HTTP 客户端
// ============================================================
const http = axios.create({ timeout: 30_000 })

// ============================================================
// 状态
// ============================================================
const loading = ref(false)
const hasSearched = ref(false)
const tableData = ref<TradeDraftItem[]>([])
const resultCardRef = ref<HTMLElement>()
const editingIndex = ref(-1)
const editForm = reactive<TradeDraftItem>({
  stockCode: '', stockName: '', direction: 'BUY',
  price: 0, volume: 0, tradeTime: '', status: 'FILLED',
})
const errorMessage = ref('')

// ---- 原生拖拽状态 ----
const isDragOver = ref(false)
const fileInputRef = ref<HTMLInputElement>()

const emit = defineEmits<{ (e: 'confirm', data: TradeDraftItem[]): void }>()

// ============================================================
// 图片校验
// ============================================================
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MIN_SIZE = 10 * 1024
const MAX_SIZE = 10 * 1024 * 1024
const MIN_WIDTH = 400
const MIN_HEIGHT = 600
const MAX_HEIGHT = 5000
const MAX_ASPECT_RATIO = 5
const MIN_ASPECT_RATIO = 0.5

function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('IMAGE_DECODE_FAILED')) }
    img.src = url
  })
}

async function checkImage(file: File): Promise<string | null> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return `不支持的文件格式 "${file.type}"，仅支持 JPG、PNG、WEBP 格式的图片文件。`
  }
  if (file.size < MIN_SIZE) {
    return `图片文件过小 (${(file.size / 1024).toFixed(1)}KB)，可能不包含有效交易数据，请上传清晰原图截图。`
  }
  if (file.size > MAX_SIZE) {
    return `图片文件超过 10MB 上限 (${(file.size / 1024 / 1024).toFixed(1)}MB)，请上传原始单屏截图。`
  }
  let width: number, height: number
  try {
    const size = await readImageSize(file)
    width = size.width; height = size.height
  } catch {
    return '无法读取该图片文件，文件可能已损坏或格式不兼容，请重新截图后上传。'
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return `图片分辨率过低 (${width}×${height})，无法保证清晰度，请上传手机原图截图。`
  }
  if (height > MAX_HEIGHT) {
    return `图片高度 ${height}px 超过上限 ${MAX_HEIGHT}px，请截取单屏页面上传，避免使用滚动截图。`
  }
  const ratio = height / width
  if (ratio > MAX_ASPECT_RATIO) {
    return `检测到超长截图（高宽比 ${ratio.toFixed(1)}:1，上限 ${MAX_ASPECT_RATIO}:1），滚动长图易导致数字遗漏，建议截取单屏（1~5笔记录）分批上传。`
  }
  if (ratio < MIN_ASPECT_RATIO) {
    return `图片比例过于扁平（高宽比 ${ratio.toFixed(2)}:1），请上传手机垂直竖屏截图。`
  }
  return null
}

// ============================================================
// 原生拖拽事件（完全绕过 el-upload）
// ============================================================

function onDragOver(e: DragEvent) {
  if (loading.value) return
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  // 只在真正离开拖拽区时取消高亮，避免进入子元素时闪烁
  const target = e.currentTarget as HTMLElement | null
  if (!target) { isDragOver.value = false; return }
  const rect = target.getBoundingClientRect()
  const x = e.clientX, y = e.clientY
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    isDragOver.value = false
  }
}

async function onDrop(e: DragEvent) {
  isDragOver.value = false
  if (loading.value) return
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  await processFile(file)
}

function triggerFileInput() {
  if (loading.value) return
  fileInputRef.value?.click()
}

async function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = '' // 允许重复选择同一文件
  await processFile(file)
}

// ============================================================
// 核心处理流程
// ============================================================

async function processFile(file: File) {
  // 清除上一次的错误
  errorMessage.value = ''
  console.log('[OCR] 接收到文件:', file.name, file.type, file.size)

  // 前置校验
  const err = await checkImage(file)
  if (err) {
    errorMessage.value = err
    ElMessage.warning(err)
    return
  }

  // 上传解析
  loading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    console.log('[OCR] 开始上传:', file.name)

    const { data } = await http.post<ApiResponse<TradeDraftItem[]>>(
      '/api/import/process-image',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    console.log('[OCR] 响应:', data)

    if (data.code === 200) {
      const list = Array.isArray(data.data) ? data.data : []
      tableData.value = list.map(normalizeItem)
      hasSearched.value = true

      if (list.length === 0) {
        errorMessage.value = '未从截图中识别到有效已成交流水，请检查截图'
        ElMessage.warning(errorMessage.value)
      } else {
        ElMessage.success(`成功识别出 ${list.length} 笔成交记录，请核对明细`)
        void nextTick(() => resultCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      }
    } else if (data.code === 400) {
      errorMessage.value = data.message || '业务校验失败，请检查截图内容'
      ElMessage.warning(errorMessage.value)
    } else {
      errorMessage.value = data.message || '服务异常，请稍后重试'
      ElMessage.error(errorMessage.value)
    }
  } catch (err) {
    handleRequestError(err)
  } finally {
    loading.value = false
  }
}

function normalizeItem(item: Partial<TradeDraftItem>): TradeDraftItem {
  return {
    stockCode: String(item.stockCode ?? '').trim(),
    stockName: String(item.stockName ?? ''),
    direction: item.direction === 'SELL' ? 'SELL' : 'BUY',
    price: Number(item.price) || 0,
    volume: Math.floor(Number(item.volume)) || 0,
    tradeTime: String(item.tradeTime ?? ''),
    status: item.status ?? 'FILLED',
  }
}

function handleRequestError(err: unknown) {
  console.error('[OCR] 请求失败:', err)
  let msg: string
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED') msg = '识别超时（30 秒），请重试或将截图压缩后再上传'
    else if (err.response) msg = `服务返回异常（HTTP ${err.response.status}），请稍后重试`
    else if (err.request) msg = '网络异常：无法连接到服务端，请确认后端服务已启动并配置了 Vite 代理'
    else msg = `请求异常：${err.message}`
  } else {
    msg = '识别失败，请稍后重试'
  }
  errorMessage.value = msg
  ElMessage.error(msg)
}

// ============================================================
// 行内修正
// ============================================================
function startEdit(index: number) {
  const row = tableData.value[index]
  if (!row) return
  Object.assign(editForm, { ...row })
  editingIndex.value = index
}
function cancelEdit() { editingIndex.value = -1 }
function saveEdit(index: number) {
  const price = Number(editForm.price)
  const volume = Math.floor(Number(editForm.volume))
  if (!/^\d{6}$/.test(editForm.stockCode.trim())) { ElMessage.warning('股票代码需为 6 位数字'); return }
  if (!(price > 0)) { ElMessage.warning('成交价格必须大于 0'); return }
  if (!(volume > 0)) { ElMessage.warning('成交数量必须为正整数'); return }
  tableData.value[index] = { ...editForm, stockCode: editForm.stockCode.trim(), price, volume }
  editingIndex.value = -1
  ElMessage.success('已保存修改')
}
function removeRow(index: number) {
  if (editingIndex.value === index) editingIndex.value = -1
  tableData.value.splice(index, 1)
}

// ============================================================
// 确认入库 / 重新上传
// ============================================================
function handleConfirm() {
  if (loading.value) return
  if (tableData.value.length === 0) { ElMessage.warning('暂无可确认入库的数据'); return }
  const invalid = tableData.value.filter(r => !/^\d{6}$/.test(r.stockCode) || !(r.price > 0) || !(r.volume > 0))
  if (invalid.length > 0) { ElMessage.warning('存在无效数据，请先修正后再入库'); return }
  emit('confirm', [...tableData.value])
  ElMessage.success(`已确认 ${tableData.value.length} 笔成交记录，等待入库`)
}

function handleReset() {
  tableData.value = []; hasSearched.value = false
  editingIndex.value = -1; errorMessage.value = ''
  isDragOver.value = false
}

// ============================================================
// 格式化工具
// ============================================================
function fmtPrice(price: number): string {
  const n = Number(price) || 0
  return Number.isInteger(n) ? n.toFixed(2) : n.toFixed(3).replace(/0+$/, '')
}
function fmtVolume(volume: number): string { return `${(Number(volume) || 0).toLocaleString('zh-CN')} 股` }
function fmtTime(t?: string): string {
  if (!t) return '—'
  const s = String(t).replace('T', ' ').trim()
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(0, 19) : s
}
const statusLabel = (s: TradeStatus) => ({ FILLED: '已成交', PARTIALLY_FILLED: '部分成交', CANCELLED: '已撤单' })[s] ?? '未知'
const statusTagType = (s: TradeStatus) => ({ FILLED: 'success' as const, PARTIALLY_FILLED: 'warning' as const, CANCELLED: 'info' as const })[s] ?? 'info'
</script>

<style scoped>
/* ========== 页面骨架 ========== */
.ocr-import-page {
  max-width: 1080px; margin: 0 auto; padding: 20px 16px;
  display: flex; flex-direction: column; gap: 16px;
}
.guide-card, .upload-card, .result-card { border-radius: 8px; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
.title { font-size: 16px; font-weight: 600; color: var(--el-text-color-primary); }

/* ========== 自定义拖拽区（替代 el-upload drag） ========== */
.custom-drop-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  border: 2px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  cursor: pointer;
  transition: all 0.25s ease;
  user-select: none;
}
.custom-drop-zone:hover {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9, rgba(64, 158, 255, 0.08));
}
.custom-drop-zone.drag-over {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-8, rgba(64, 158, 255, 0.12));
  transform: scale(1.01);
}
.custom-drop-zone.is-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.drop-content, .drop-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 30px 0 26px;
  pointer-events: none;
}
.drop-loading .loading-icon {
  animation: spin 1s linear infinite;
  color: var(--el-color-primary);
}
.loading-text {
  font-size: 14px;
  color: var(--el-color-primary);
}
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.upload-icon { font-size: 46px; color: var(--el-color-primary); margin-bottom: 6px; }
.upload-title { font-size: 15px; font-weight: 500; color: var(--el-text-color-primary); }
.upload-hint { font-size: 12px; color: var(--el-text-color-secondary); }

/* ========== 结果表格 ========== */
.code-text { font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace; letter-spacing: 0.5px; }
.name-text { font-weight: 600; }
.result-footer { margin-top: 16px; display: flex; justify-content: flex-end; gap: 12px; }

/* ========== 平滑淡入动画 ========== */
.fade-slide-enter-active, .fade-slide-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.fade-slide-enter-from, .fade-slide-leave-to { opacity: 0; transform: translateY(12px); }

/* ========== 小屏适配 ========== */
@media (max-width: 768px) { .result-footer { flex-direction: column; } .result-footer .el-button { width: 100%; margin-left: 0 !important; } }
</style>
