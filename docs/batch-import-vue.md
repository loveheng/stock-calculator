# 修复记录：el-upload 拖拽无响应

## 根因

`el-upload` 的 `drag` 模式在特定组合下存在三个已知问题：

1. **`accept` 属性静默过滤**：拖入文件扩展名不匹配时，`el-upload` 在 `onDrop` 内部直接 `return`，不触发 `before-upload` / `on-change` 等任何钩子，也不给出任何视觉反馈。
2. **`v-loading` 指令与 `el-upload` 的 drag zone 冲突**：`v-loading` 创建的遮罩层（即使 `display: none`）在某些浏览器版本中会拦截 `dragenter`/`dragover`/`drop` 事件。
3. **`show-file-list="false"` 时内部状态管理异常**：`el-upload` 在隐藏文件列表后，内部文件队列的增删操作与钩子触发时序存在版本差异。

## 最终方案：原生 HTML5 Drag & Drop

移除 `el-upload` 的拖拽功能，改用原生事件 + 隐藏 `<input type="file">`。`el-upload` 仅保留点击选择文件功能（`auto-upload="false"`，不处理拖拽）。

```vue
<template>
  <!-- ... 顶部说明卡片，与之前一致 ... -->

  <el-card shadow="never" class="upload-card">
    <!-- 自定义拖拽区 -->
    <div
      class="custom-drop-zone"
      :class="{ 'drag-over': isDragOver, 'is-disabled': loading }"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
      @click="triggerFileInput"
    >
      <div v-if="loading" class="drop-loading">
        <el-icon class="loading-icon"><Loading /></el-icon>
        <span>正在智能提取交割单明细，请稍候...</span>
      </div>
      <div v-else class="drop-content">
        <el-icon class="upload-icon"><UploadFilled /></el-icon>
        <div class="upload-title">点击或将截图拖拽到此处</div>
        <div class="upload-hint">支持单屏截图智能识别（深色 / 浅色模式均可）</div>
        <div class="upload-hint">JPG / PNG / WEBP · 10KB ~ 10MB · 单屏截图</div>
      </div>
    </div>
    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      style="display: none"
      @change="onFileSelect"
    />
  </el-card>

  <!-- ... 结果表格，与之前一致 ... -->
</template>

<script setup lang="ts">
// ... 其他导入 ...

const isDragOver = ref(false)
const fileInputRef = ref<HTMLInputElement>()

function onDragOver(e: DragEvent) {
  if (loading.value) return
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  // 只在离开拖拽区时取消高亮，避免进入子元素时闪烁
  const rect = (e.currentTarget as HTMLElement)?.getBoundingClientRect()
  if (rect) {
    const x = e.clientX, y = e.clientY
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      isDragOver.value = false
    }
  } else {
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

async function processFile(file: File) {
  errorMessage.value = ''
  console.log('[OCR] 文件:', file.name, file.type, file.size)

  // 校验
  const err = await checkImage(file)
  if (err) {
    errorMessage.value = err
    ElMessage.warning(err)
    return
  }

  // 上传
  loading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    console.log('[OCR] 开始上传...')

    const { data } = await http.post<ApiResponse<TradeDraftItem[]>>(
      '/api/import/process-image',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    console.log('[OCR] 响应:', data)

    if (data.code === 200) {
      // ... 处理结果 ...
    } else if (data.code === 400) {
      errorMessage.value = data.message || '业务校验失败'
      ElMessage.warning(errorMessage.value)
    } else {
      errorMessage.value = data.message || '服务异常'
      ElMessage.error(errorMessage.value)
    }
  } catch (err) {
    handleRequestError(err)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.custom-drop-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  border: 2px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  cursor: pointer;
  transition: all 0.2s ease;
}
.custom-drop-zone:hover {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.custom-drop-zone.drag-over {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-8);
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
  padding: 28px 0;
  pointer-events: none;
}
.drop-loading .loading-icon {
  font-size: 28px;
  animation: spin 1s linear infinite;
}
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.upload-icon { font-size: 46px; color: var(--el-color-primary); margin-bottom: 6px; }
.upload-title { font-size: 15px; font-weight: 500; color: var(--el-text-color-primary); }
.upload-hint { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
```
