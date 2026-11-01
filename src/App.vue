<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-block">
        <svg class="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
          <path d="M18 2 32 10v16L18 34 4 26V10Z" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="m11 22 5-11 4 7 5-4" fill="none" stroke="currentColor" stroke-width="2" />
          <circle cx="11" cy="22" r="2" fill="currentColor" /><circle cx="25" cy="14" r="2" fill="currentColor" />
        </svg>
        <div><strong>REBOT<span>/</span>CONTROL</strong><small>ROS 2 OPERATIONS CONSOLE</small></div>
      </div>
      <div class="mode-switch" aria-label="数据源模式">
        <button type="button" :aria-pressed="mode === 'demo'" :class="{ active: mode === 'demo' }" @click="switchMode('demo')">浏览器演示</button>
        <button type="button" :aria-pressed="mode === 'ros'" :class="{ active: mode === 'ros' }" @click="switchMode('ros')">ROS 2 目标</button>
      </div>
      <div class="header-status">
        <div class="connection-badge" :class="`state-${mode === 'demo' ? 'demo' : connection}`">
          <span class="live-dot" />{{ connectionLabel }}
        </div>
        <div class="header-metric"><small>反馈频率</small><strong>{{ mode === 'demo' ? 'LOCAL' : `${feedbackRate} Hz` }}</strong></div>
      </div>
    </header>

    <section class="connection-bar" aria-label="rosbridge 连接设置">
      <div class="connection-title"><Cable :size="16" /><span>ROSBRIDGE</span></div>
      <label class="url-field"><span>WEBSOCKET</span><input v-model="url" :disabled="mode === 'demo' || connection === 'connected'" :spellcheck="false" /></label>
      <label class="namespace-field"><span>NAMESPACE</span><input v-model="namespace" :disabled="mode === 'demo' || connection === 'connected'" :spellcheck="false" /></label>
      <button
        type="button"
        :class="connection === 'connected' ? 'disconnect-button' : 'connect-button'"
        :disabled="mode === 'demo'"
        @click="connection === 'connected' || connection === 'connecting' ? disconnect() : connect()"
      >
        <Unplug v-if="connection === 'connected'" :size="15" />
        <Radio v-else :size="15" />
        {{ connection === 'connected' ? '断开' : connection === 'connecting' ? '取消连接' : '连接 ROS 2' }}
      </button>
      <div class="transport-note">roslibjs · 9090</div>
    </section>

    <SystemPowerPanel />

    <InterfacePanel
      :mode="mode"
      :connection="connection"
      :topics="topicStats"
      :calls="interfaceCalls"
      @clear="clearInterfaceLog"
    />

    <div class="safety-bar" :class="{ confirmed: safetyConfirmed || mode === 'demo' }">
      <template v-if="mode === 'demo'">
        <Activity :size="15" /><span><strong>演示数据</strong>　所有运动和状态均在浏览器本地生成，不会访问硬件。</span>
      </template>
      <label v-else>
        <input v-model="safetyConfirmed" type="checkbox" />
        <span class="check-box"><Check v-if="safetyConfirmed" :size="12" /></span>
        <ShieldCheck :size="15" />
        <span>我已确认目标命名空间、工作区和物理急停；网页“取消任务”不能替代物理急停。</span>
      </label>
    </div>

    <main class="workspace-grid">
      <JointPanel
        :current="current"
        :target="target"
        :gripper-raw="gripperRaw"
        :arm-status="armStatus"
        :run-state="runState"
        :controls-disabled="controlsDisabled"
        @update:target="updateTarget"
        @execute="executeTrajectory"
        @service="runSingleService"
      />

      <section class="center-workspace" aria-label="实时模型与反馈">
        <Suspense>
          <RobotScene :joints="current" :gripper-raw="gripperRaw" :running="busy" />
          <template #fallback>
            <div class="robot-scene"><div class="scene-message">正在初始化 3D 视图…</div></div>
          </template>
        </Suspense>
        <div class="telemetry-strip">
          <div><small>数据源</small><strong>{{ mode === 'demo' ? 'BROWSER SIM' : `${namespace}/joint_states` }}</strong></div>
          <div><small>执行状态</small><strong class="run-state" :class="`state-${runState}`">{{ runState.toUpperCase() }}</strong></div>
          <div><small>最后反馈</small><strong>{{ lastFeedbackLabel }}</strong></div>
          <div><small>控制链路</small><strong>{{ mode === 'demo' ? 'LOCAL ONLY' : 'ROS ACTION / SRV' }}</strong></div>
        </div>
        <div class="workspace-caption">
          <span>模型显示实际关节反馈；目标值只有在点击执行后才会发送。</span>
          <span>THREE.JS / URDF</span>
        </div>
      </section>

      <SequencePanel
        :active-step="activeStep"
        :run-state="runState"
        :logs="logs"
        @clear-logs="clearLogs"
        @run="requestSequence"
        @cancel="cancelTask"
      />
    </main>

    <footer class="app-footer">
      <span>REBOT ARM B601-RS</span>
      <span>先在演示环境验证，再低速连接真机。设置与序列只保存在当前浏览器。</span>
      <span>ROS 2 / ROSLIBJS</span>
    </footer>

    <ConfirmDialog
      :open="confirmation !== null"
      :title="confirmation?.title || ''"
      :description="confirmation?.description || ''"
      :confirm-label="confirmation?.confirmLabel || '确认'"
      @confirm="confirmPending"
      @close="confirmation = null"
    />
  </div>
</template>


<script lang="ts">
import { defineAsyncComponent, defineComponent } from 'vue'
import { Activity, Cable, Check, Radio, ShieldCheck, Unplug } from '@lucide/vue'
import JointPanel from '@/components/JointPanel.vue'
import SequencePanel from '@/components/SequencePanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SystemPowerPanel from '@/components/SystemPowerPanel.vue'
import InterfacePanel from '@/components/InterfacePanel.vue'
import { useRebot } from '@/composables/useRebot'
import type { SequenceStep } from '@/lib/robot'
import './App.css'

const RobotScene = defineAsyncComponent(() => import('@/components/RobotScene.vue'))

interface PendingConfirmation {
  title: string
  description: string
  confirmLabel: string
  action: () => void
}

export default defineComponent({
  name: 'App',
  components: {
    Activity,
    Cable,
    Check,
    Radio,
    ShieldCheck,
    Unplug,
    JointPanel,
    SequencePanel,
    ConfirmDialog,
    SystemPowerPanel,
    InterfacePanel,
    RobotScene,
  },
  setup() {
    return { ...useRebot() }
  },
  data() {
    return {
      confirmation: null as PendingConfirmation | null,
    }
  },
  computed: {
    busy(): boolean {
      return this.runState === 'running'
    },
    controlsDisabled(): boolean {
      return this.mode === 'ros' && (this.connection !== 'connected' || !this.safetyConfirmed)
    },
    connectionLabel(): string {
      if (this.mode === 'demo') return '本地演示'
      return ({
        connected: 'ROS 已连接',
        connecting: '正在连接',
        disconnected: '未连接',
        error: '连接异常',
      })[this.connection]
    },
    lastFeedbackLabel(): string {
      return this.lastFeedback
        ? new Date(this.lastFeedback).toLocaleTimeString('zh-CN', { hour12: false })
        : '—'
    },
  },
  methods: {
    requestSequence(steps: SequenceStep[]) {
      if (this.mode === 'ros') {
        this.confirmation = {
          title: '确认在 ROS 2 目标上运行序列？',
          description: `将向 ${this.namespace} 连续发送 ${steps.length} 个步骤。请确认命名空间正确、工作区无人且物理急停可用。`,
          confirmLabel: '确认并运行',
          action: () => {
            void this.runSequence(steps)
          },
        }
      } else {
        void this.runSequence(steps)
      }
    },
    updateTarget(positions: number[]) {
      this.target = positions
    },
    confirmPending() {
      this.confirmation?.action()
    },
  },
})
</script>

