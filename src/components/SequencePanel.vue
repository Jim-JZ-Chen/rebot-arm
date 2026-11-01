<template>
  <aside class="panel sequence-panel" aria-label="动作编排与事件日志">
    <section class="panel-section sequence-section">
      <div class="section-heading">
        <h2>动作序列</h2>
        <span>{{ steps.length.toString().padStart(2, '0') }} STEPS</span>
      </div>
      <p class="section-note">逐步等待 Action / Service 真实结果。编辑内容仅保存在当前浏览器。</p>
      <div class="sequence-actions">
        <button type="button" class="primary-button" :disabled="busy || !steps.length" @click="$emit('run', steps)">
          <Play :size="15" fill="currentColor" />运行序列
        </button>
        <button type="button" class="secondary-button" :disabled="!busy" @click="$emit('cancel')">
          <Square :size="14" />取消任务
        </button>
      </div>
      <ol class="step-list">
        <li
          v-for="(step, index) in steps"
          :key="step.id"
          :class="{ selected: selectedId === step.id, active: activeStep === index }"
        >
          <button type="button" class="step-select" @click="selectedId = step.id">
            <span class="step-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="step-copy"><strong>{{ step.name }}</strong><small>{{ stepSummary(step) }}</small></span>
            <span class="step-type" :class="`type-${step.type}`">{{ step.type.toUpperCase() }}</span>
          </button>
          <div class="step-tools">
            <button type="button" :disabled="index === 0 || busy" :aria-label="`上移${step.name}`" @click="moveStep(index, -1)"><ChevronUp :size="13" /></button>
            <button type="button" :disabled="index === steps.length - 1 || busy" :aria-label="`下移${step.name}`" @click="moveStep(index, 1)"><ChevronDown :size="13" /></button>
            <button type="button" :disabled="busy" :aria-label="`删除${step.name}`" @click="removeStep(step.id)"><Trash2 :size="13" /></button>
          </div>
        </li>
      </ol>
      <div v-if="!steps.length" class="empty-state">还没有步骤。请选择类型并添加第一步。</div>
      <div class="add-step-row">
        <select aria-label="新步骤类型" :value="newType" @change="setNewType(inputValue($event))">
          <option value="joint">关节轨迹</option>
          <option value="gripper">夹爪动作</option>
          <option value="wait">等待</option>
          <option value="home">安全回零</option>
        </select>
        <button type="button" :disabled="busy" @click="addStep"><Plus :size="15" />添加步骤</button>
      </div>
      <div class="file-actions">
        <button type="button" @click="openFilePicker"><Upload :size="14" />导入 JSON</button>
        <button type="button" :disabled="!steps.length" @click="exportSequence"><Download :size="14" />导出 JSON</button>
        <input ref="fileRef" type="file" accept="application/json,.json" hidden @change="importSequence" />
      </div>
      <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
    </section>

    <section v-if="selected" class="panel-section step-editor">
      <div class="section-heading"><h2>步骤设置</h2><span>{{ selected.type.toUpperCase() }}</span></div>
      <label>步骤名称<input :value="selected.name" @input="updateName(inputValue($event))" /></label>
      <template v-if="selected.type === 'joint'">
        <div class="editor-joint-grid">
          <label v-for="(position, index) in selected.positions" :key="index">J{{ index + 1 }} °
            <input
              type="number"
              :step="1"
              :value="Number(radToDeg(position).toFixed(1))"
              @input="updateJointPosition(index, Number(inputValue($event)))"
            />
          </label>
        </div>
        <label>时长（秒）<input type="number" :min="0.2" :step="0.2" :value="selected.duration" @input="updateDuration(Number(inputValue($event)))" /></label>
      </template>
      <label v-if="selected.type === 'gripper'">夹爪动作
        <select :value="selected.action" @change="updateGripperAction(inputValue($event) as 'open' | 'close')">
          <option value="open">张开</option>
          <option value="close">闭合</option>
        </select>
      </label>
      <label v-if="selected.type === 'wait'">等待（秒）<input type="number" :min="0" :step="0.2" :value="selected.duration" @input="updateDuration(Number(inputValue($event)))" /></label>
      <p v-if="selected.type === 'home'" class="section-note">调用控制器的安全回零服务，并等待成功或失败结果。</p>
    </section>

    <section class="panel-section log-section">
      <div class="section-heading"><h2>事件日志</h2><button type="button" class="text-button" @click="$emit('clearLogs')">清空</button></div>
      <div ref="logListRef" class="log-list" aria-live="polite">
        <div v-for="log in logs" :key="log.id" class="log-entry" :class="`log-${log.level}`">
          <time>{{ log.time }}</time><span>{{ log.message }}</span>
        </div>
        <div v-if="!logs.length" class="empty-log">暂无事件</div>
      </div>
    </section>
  </aside>
</template>


<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import { ChevronDown, ChevronUp, Download, Play, Plus, Square, Trash2, Upload } from '@lucide/vue'
import type { LogEntry, RunState, SequenceStep } from '@/lib/robot'
import {
  DEFAULT_SEQUENCE,
  READY_POSE,
  degToRad,
  radToDeg,
  stepSummary,
  uid,
} from '@/lib/robot'

function loadSequence(): SequenceStep[] {
  try {
    const saved = localStorage.getItem('rebot.sequence')
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.every((step) => step.id && step.type)) return parsed
    }
  } catch {
    // Invalid local data falls back to the known-safe editor example.
  }
  return DEFAULT_SEQUENCE
}

export default defineComponent({
  name: 'SequencePanel',
  components: { ChevronDown, ChevronUp, Download, Play, Plus, Square, Trash2, Upload },
  props: {
    activeStep: { type: Number as PropType<number | null>, default: null },
    runState: { type: String as PropType<RunState>, required: true },
    logs: { type: Array as PropType<LogEntry[]>, required: true },
  },
  emits: ['run', 'cancel', 'clearLogs'],
  data() {
    const steps = loadSequence()
    return {
      steps,
      selectedId: steps[0]?.id || '',
      newType: 'joint' as SequenceStep['type'],
      importError: '',
    }
  },
  computed: {
    busy(): boolean {
      return this.runState === 'running'
    },
    selected(): SequenceStep | undefined {
      return this.steps.find((step) => step.id === this.selectedId)
    },
  },
  watch: {
    steps: {
      deep: true,
      handler(value: SequenceStep[]) {
        localStorage.setItem('rebot.sequence', JSON.stringify(value))
      },
    },
    async logs() {
      await this.$nextTick()
      const list = this.$refs.logListRef as HTMLDivElement | undefined
      if (list) list.scrollTop = list.scrollHeight
    },
  },
  methods: {
    stepSummary,
    radToDeg,
    inputValue(event: Event) {
      return (event.target as HTMLInputElement | HTMLSelectElement).value
    },
    openFilePicker() {
      const input = this.$refs.fileRef as HTMLInputElement | undefined
      input?.click()
    },
    updateSelected(next: SequenceStep) {
      this.steps = this.steps.map((item) => (item.id === next.id ? next : item))
    },
    updateName(name: string) {
      if (this.selected) this.updateSelected({ ...this.selected, name })
    },
    updateJointPosition(index: number, value: number) {
      const step = this.selected
      if (step?.type !== 'joint') return
      const positions = [...step.positions]
      positions[index] = degToRad(value)
      this.updateSelected({ ...step, positions })
    },
    updateDuration(value: number) {
      const step = this.selected
      if (step?.type === 'joint') this.updateSelected({ ...step, duration: Math.max(0.2, value) })
      if (step?.type === 'wait') this.updateSelected({ ...step, duration: Math.max(0, value) })
    },
    updateGripperAction(action: 'open' | 'close') {
      const step = this.selected
      if (step?.type === 'gripper') this.updateSelected({ ...step, action })
    },
    setNewType(value: string) {
      this.newType = value as SequenceStep['type']
    },
    addStep() {
      const id = uid()
      const base = { id, name: `新步骤 ${this.steps.length + 1}` }
      let step: SequenceStep
      if (this.newType === 'joint') step = { ...base, type: 'joint', positions: [...READY_POSE], duration: 3 }
      else if (this.newType === 'gripper') step = { ...base, type: 'gripper', action: 'open' }
      else if (this.newType === 'wait') step = { ...base, type: 'wait', duration: 1 }
      else step = { ...base, type: 'home' }
      this.steps = [...this.steps, step]
      this.selectedId = id
    },
    removeStep(id: string) {
      const next = this.steps.filter((step) => step.id !== id)
      this.steps = next
      if (this.selectedId === id) this.selectedId = next[0]?.id || ''
    },
    moveStep(index: number, direction: -1 | 1) {
      const destination = index + direction
      if (destination < 0 || destination >= this.steps.length) return
      const next = [...this.steps]
      const currentStep = next[index]
      next[index] = next[destination]
      next[destination] = currentStep
      this.steps = next
    },
    exportSequence() {
      const blob = new Blob([JSON.stringify({ format: 'rebot-sequence', version: 1, steps: this.steps }, null, 2)], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = 'rebot-动作序列.json'
      anchor.click()
      URL.revokeObjectURL(href)
    },
    async importSequence(event: Event) {
      const input = event.target as HTMLInputElement
      const file = input.files?.[0]
      input.value = ''
      if (!file) return
      try {
        const parsed = JSON.parse(await file.text())
        const imported = Array.isArray(parsed) ? parsed : parsed.steps
        if (!Array.isArray(imported) || !imported.every((step) => step.id && step.type && step.name)) {
          throw new Error('文件中没有有效的步骤列表')
        }
        this.steps = imported
        this.selectedId = imported[0]?.id || ''
        this.importError = ''
      } catch (error) {
        this.importError = error instanceof Error ? error.message : 'JSON 导入失败'
      }
    },
  },
})
</script>

