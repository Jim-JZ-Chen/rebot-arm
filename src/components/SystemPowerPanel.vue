<template>
  <section class="system-power" aria-label="机械臂系统启动与关机">
    <div class="power-header">
      <div class="power-title">
        <Power :size="16" />
        <strong>系统电源</strong>
        <span class="launcher-mode" :class="status?.launcherMode === 'mock' ? 'is-mock' : ''">
          {{ status?.launcherMode === 'systemd' ? 'SYSTEMD' : status?.launcherMode === 'mock' ? '模拟启动器' : '未连接' }}
        </span>
      </div>

      <div class="service-summary" aria-label="系统服务状态">
        <span v-for="service in serviceItems" :key="service.id" :class="{ active: service.active }">
          <i />{{ service.label }} · {{ service.active ? '运行' : '停止' }}
        </span>
      </div>

      <div class="power-actions">
        <button type="button" class="power-start" :disabled="busy || !status" @click="runOperation('start')">
          <Power :size="14" />启动系统
        </button>
        <button type="button" class="power-stop" :disabled="busy || !status" @click="confirmation = 'shutdown'">
          <PowerOff :size="14" />关闭机械臂系统
        </button>
        <button type="button" class="power-host-stop" :disabled="busy || !status" @click="confirmation = 'host'">
          <MonitorOff :size="14" />关闭 ROS 主机
        </button>
        <button type="button" class="power-refresh" title="刷新系统状态" aria-label="刷新系统状态" @click="refresh">
          <RefreshCw :size="14" />
        </button>
      </div>
    </div>

    <div v-if="job" class="power-progress" :class="`job-${job.status}`">
      <div class="power-progress-heading">
        <strong>{{ job.label }}</strong>
        <span>{{ job.status === 'running' ? '执行中' : job.status === 'success' ? '全部完成' : job.status === 'error' ? '流程已中止' : '等待执行' }}</span>
      </div>
      <ol class="power-steps">
        <li v-for="(step, index) in job.steps" :key="step.id" :class="`step-${step.status}`">
          <span class="power-step-icon">
            <LoaderCircle v-if="step.status === 'running'" :size="16" class="spin" />
            <Check v-else-if="step.status === 'success'" :size="16" />
            <X v-else-if="step.status === 'error'" :size="16" />
            <Minus v-else-if="step.status === 'skipped'" :size="16" />
            <Circle v-else :size="12" />
          </span>
          <div>
            <strong><small>{{ String(index + 1).padStart(2, '0') }}</small>{{ step.name }}</strong>
            <span>{{ step.detail || stepStatusLabel[step.status] }}</span>
          </div>
        </li>
      </ol>
      <p v-if="job.error" class="power-job-error" role="alert">{{ job.error }}</p>
    </div>

    <div class="power-footnote">
      <span>启动只运行软件，不会自动使能电机；任何安全步骤失败都会停止后续操作。</span>
      <span v-if="status?.launcherMode === 'mock'">当前仅演示步骤，不访问 ROS 服务或硬件。</span>
    </div>
    <p v-if="requestError" class="power-request-error" :class="{ 'is-host-notice': hostNotice }" role="alert">{{ requestError }}</p>

    <ConfirmDialog
      :open="confirmation !== null"
      :title="dialogCopy.title"
      :description="dialogCopy.description"
      :confirm-label="dialogCopy.confirmLabel"
      @confirm="confirmOperation"
      @close="confirmation = null"
    />
  </section>
</template>


<script lang="ts">
import { defineComponent } from 'vue'
import { Check, Circle, LoaderCircle, Minus, MonitorOff, Power, PowerOff, RefreshCw, X } from '@lucide/vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

type Operation = 'start' | 'shutdown' | 'host'
type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

interface PowerStep {
  id: string
  name: string
  status: StepStatus
  detail: string
}

interface PowerJob {
  id: string
  operation: Operation
  label: string
  launcherMode: 'mock' | 'systemd'
  status: 'pending' | 'running' | 'success' | 'error'
  error?: string
  steps: PowerStep[]
}

interface SystemStatus {
  launcherMode: 'mock' | 'systemd'
  services: {
    can: boolean
    driver: boolean
    rosbridge: boolean
  }
  job: PowerJob | null
}

const stepStatusLabel: Record<StepStatus, string> = {
  pending: '等待执行',
  running: '正在执行',
  success: '成功',
  error: '失败',
  skipped: '跳过',
}

export default defineComponent({
  name: 'SystemPowerPanel',
  components: { Check, Circle, LoaderCircle, Minus, MonitorOff, Power, PowerOff, RefreshCw, X, ConfirmDialog },
  data() {
    return {
      status: null as SystemStatus | null,
      requestError: '',
      hostNotice: false,
      confirmation: null as 'shutdown' | 'host' | null,
      stepStatusLabel,
      timer: undefined as number | undefined,
      refreshGeneration: 0,
      disposed: false,
    }
  },
  computed: {
    busy(): boolean {
      return this.status?.job?.status === 'running' || this.status?.job?.status === 'pending'
    },
    job(): PowerJob | null {
      return this.status?.job || null
    },
    dialogCopy(): { title: string; description: string; confirmLabel: string } {
      return this.confirmation === 'host'
        ? {
            title: '确认关闭整台 ROS 主机？',
            description: '将先安全回零、禁用机械臂并停止驱动，然后关闭整台控制电脑。关机后无法通过本页面重新开机，必须人工上电。',
            confirmLabel: '确认关闭主机',
          }
        : {
            title: '确认关闭机械臂系统？',
            description: '将按顺序安全回零、禁用机械臂，并停止 ROS 驱动、rosbridge 和 CAN。任一步骤失败都会中止后续操作。',
            confirmLabel: '确认关闭系统',
          }
    },
    serviceItems(): { id: string; label: string; active: boolean | undefined }[] {
      return [
        { id: 'can', label: 'CAN', active: this.status?.services.can },
        { id: 'driver', label: 'ROS 驱动', active: this.status?.services.driver },
        { id: 'rosbridge', label: 'ROSBRIDGE', active: this.status?.services.rosbridge },
      ]
    },
  },
  mounted() {
    void this.refresh()
  },
  beforeUnmount() {
    this.disposed = true
    window.clearTimeout(this.timer)
  },
  methods: {
    scheduleRefresh() {
      if (this.disposed) return
      window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => void this.refresh(), this.busy ? 500 : 5000)
    },
    async refresh() {
      if (this.disposed) return
      const generation = ++this.refreshGeneration
      try {
        const response = await fetch('/api/system/status', { cache: 'no-store' })
        const body = await response.json()
        if (generation !== this.refreshGeneration) return
        if (!response.ok) throw new Error(body.error || `启动器返回 ${response.status}`)
        this.status = body
        this.requestError = ''
      } catch (error) {
        if (generation !== this.refreshGeneration) return
        this.requestError = `启动器连接失败：${error instanceof Error ? error.message : String(error)}`
      } finally {
        if (generation === this.refreshGeneration) this.scheduleRefresh()
      }
    },
    async runOperation(operation: Operation) {
      this.requestError = ''
      this.hostNotice = false
      const path = operation === 'start'
        ? '/api/system/start'
        : operation === 'shutdown'
          ? '/api/system/shutdown'
          : '/api/system/host-shutdown'
      const confirm = operation === 'start' ? 'START' : operation === 'shutdown' ? 'ARM_SHUTDOWN' : 'HOST_SHUTDOWN'
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm }),
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || `操作请求失败（${response.status}）`)
        await this.refresh()
      } catch (error) {
        if (operation === 'host') {
          this.hostNotice = true
          this.requestError = '主机连接中断。若“关闭 ROS 主机”已显示成功，这是预期现象；请等待主机断电。'
        } else {
          this.requestError = error instanceof Error ? error.message : String(error)
        }
      }
    },
    confirmOperation() {
      if (!this.confirmation) return
      const operation = this.confirmation
      this.confirmation = null
      void this.runOperation(operation)
    },
  },
})
</script>

