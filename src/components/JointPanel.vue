
<template>
  <aside class="panel joint-panel" aria-label="关节状态">
    <section class="panel-section status-section">
      <div class="section-heading">
        <h2>机械臂状态</h2>
        <span class="status-text" :class="{ ok: armStatus.enabled }">{{ enabledLabel }}</span>
      </div>
      <dl class="status-grid">
        <div><dt>状态机</dt><dd>{{ String(armStatus.state_machine ?? '等待反馈') }}</dd></div>
        <div><dt>控制模式</dt><dd>{{ String(armStatus.control_mode ?? 'MIT / ROS') }}</dd></div>
        <div><dt>错误码</dt><dd :class="{ 'danger-text': Number(armStatus.error_code) }">{{ String(armStatus.error_code ?? '—') }}</dd></div>
      </dl>
    </section>

    <section class="panel-section joint-section">
      <div class="section-heading">
        <h2>关节角度</h2>
        <span>DEG</span>
      </div>
      <div class="joint-list">
        <div v-for="(name, index) in JOINT_NAMES" :key="name" class="joint-row">
          <div class="joint-meta">
            <strong>J{{ index + 1 }}</strong>
            <span>{{ formatDeg(current[index]) }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="panel-section command-section">
      <div class="section-heading"><h2>系统命令</h2><span>ROS SRV</span></div>
      <div class="command-grid">
        <button type="button" :disabled="busy || controlsDisabled" @click="$emit('service', 'enable')">
          <Power :size="15" />
          <span class="command-label">启用<span class="command-iface">{{ namespace }}/enable</span></span>
        </button>
        <button type="button" :disabled="busy || controlsDisabled" @click="$emit('service', 'home')">
          <Home :size="15" />
          <span class="command-label">安全回零<span class="command-iface">{{ namespace }}/safe_home</span></span>
        </button>
      </div>
      <button type="button" class="disable-button" :disabled="busy || controlsDisabled" @click="$emit('service', 'disable')">
        <RotateCcw :size="15" />
        <span class="command-label">安全回零并禁用<span class="command-iface">{{ namespace }}/disable</span></span>
      </button>
    </section>
  </aside>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import { Home, Power, RotateCcw } from '@lucide/vue'
import type { ArmStatus, RunState } from '@/lib/robot'
import { formatDeg, JOINT_NAMES } from '@/lib/robot'

export default defineComponent({
  name: 'JointPanel',
  components: { Home, Power, RotateCcw },
  props: {
    current: { type: Array as PropType<number[]>, required: true },
    armStatus: { type: Object as PropType<ArmStatus>, required: true },
    runState: { type: String as PropType<RunState>, required: true },
    controlsDisabled: { type: Boolean, required: true },
    namespace: { type: String, required: true },
  },
  emits: ['service'],
  data() {
    return {
      JOINT_NAMES,
    }
  },
  computed: {
    busy(): boolean {
      return this.runState === 'running'
    },
    enabledLabel(): string {
      return this.armStatus.enabled === undefined ? '未知' : this.armStatus.enabled ? '已启用' : '未启用'
    },
  },
  methods: {
    formatDeg,
  },
})
</script>
