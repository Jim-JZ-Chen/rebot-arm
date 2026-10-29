<script setup lang="ts">
import { computed } from 'vue'
import { Hand, Home, Play, Power, RotateCcw } from '@lucide/vue'
import type { ArmStatus, RunState } from '@/lib/robot'
import {
  formatDeg,
  JOINT_LIMITS,
  JOINT_NAMES,
  OBSERVE_POSE,
  radToDeg,
  READY_POSE,
  ZERO_POSE,
  clampJoint,
  degToRad,
} from '@/lib/robot'

type ServiceKind = 'enable' | 'disable' | 'home' | 'open' | 'close'

const props = defineProps<{
  current: number[]
  target: number[]
  gripperRaw: number
  armStatus: ArmStatus
  runState: RunState
  controlsDisabled: boolean
}>()

const emit = defineEmits<{
  'update:target': [positions: number[]]
  execute: [positions?: number[], duration?: number]
  service: [kind: ServiceKind]
}>()

const busy = computed(() => props.runState === 'running')
const gripperWidth = computed(() => Math.max(0, Math.min(71.5, (props.gripperRaw / 5) * 71.5)))
const enabledLabel = computed(() => props.armStatus.enabled === undefined ? '未知' : props.armStatus.enabled ? '已启用' : '未启用')
const inputValue = (event: Event) => (event.target as HTMLInputElement).value

const setTarget = (positions: number[]) => {
  emit('update:target', positions)
}

const updateJoint = (index: number, value: number) => {
  const next = [...props.target]
  next[index] = clampJoint(index, value)
  setTarget(next)
}

const jog = (index: number, deltaDeg: number) => {
  const next = [...props.current]
  next[index] = clampJoint(index, next[index] + degToRad(deltaDeg))
  setTarget(next)
  emit('execute', next, 0.8)
}
</script>

<template>
  <aside class="panel joint-panel" aria-label="关节控制">
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
        <h2>关节目标</h2>
        <span>RAD / DEG</span>
      </div>
      <div class="joint-table-head" aria-hidden="true">
        <span>轴</span><span>反馈</span><span>目标</span><span>点动</span>
      </div>
      <div class="joint-list">
        <div v-for="(name, index) in JOINT_NAMES" :key="name" class="joint-row">
          <div class="joint-meta">
            <strong>J{{ index + 1 }}</strong>
            <span>{{ formatDeg(current[index]) }}</span>
            <input
              class="joint-number"
              type="number"
              :aria-label="`J${index + 1} 目标角度`"
              :min="radToDeg(JOINT_LIMITS[index][0])"
              :max="radToDeg(JOINT_LIMITS[index][1])"
              :step="0.5"
              :value="Number(radToDeg(target[index]).toFixed(1))"
              @input="updateJoint(index, degToRad(Number(inputValue($event))))"
            />
            <div class="jog-buttons">
              <button type="button" :disabled="busy || controlsDisabled" :aria-label="`J${index + 1} 负向点动 1 度`" @click="jog(index, -1)">−</button>
              <button type="button" :disabled="busy || controlsDisabled" :aria-label="`J${index + 1} 正向点动 1 度`" @click="jog(index, 1)">+</button>
            </div>
          </div>
          <input
            class="joint-slider"
            type="range"
            :aria-label="`J${index + 1} 目标滑杆`"
            :min="JOINT_LIMITS[index][0]"
            :max="JOINT_LIMITS[index][1]"
            :step="0.002"
            :value="target[index]"
            @input="updateJoint(index, Number(inputValue($event)))"
          />
        </div>
      </div>
      <div class="preset-row" aria-label="目标位姿预设">
        <button type="button" @click="setTarget([...ZERO_POSE])">零位</button>
        <button type="button" @click="setTarget([...READY_POSE])">准备位</button>
        <button type="button" @click="setTarget([...OBSERVE_POSE])">观察位</button>
      </div>
      <button type="button" class="primary-button execute-button" :disabled="busy || controlsDisabled" @click="emit('execute')">
        <Play :size="16" fill="currentColor" />
        执行关节目标
        <span>3.0 S</span>
      </button>
    </section>

    <section class="panel-section command-section">
      <div class="section-heading"><h2>系统命令</h2><span>ROS SRV</span></div>
      <div class="command-grid">
        <button type="button" :disabled="busy || controlsDisabled" @click="emit('service', 'enable')"><Power :size="15" />启用</button>
        <button type="button" :disabled="busy || controlsDisabled" @click="emit('service', 'home')"><Home :size="15" />安全回零</button>
        <button type="button" :disabled="busy || controlsDisabled" @click="emit('service', 'open')"><Hand :size="15" />张开夹爪</button>
        <button type="button" :disabled="busy || controlsDisabled" @click="emit('service', 'close')"><Hand :size="15" />闭合夹爪</button>
      </div>
      <div class="gripper-readout">
        <span>夹爪开度</span>
        <div class="gripper-track"><span :style="{ width: `${(gripperWidth / 71.5) * 100}%` }" /></div>
        <strong>{{ gripperWidth.toFixed(1) }} mm</strong>
      </div>
      <button type="button" class="disable-button" :disabled="busy || controlsDisabled" @click="emit('service', 'disable')">
        <RotateCcw :size="15" />安全回零并禁用
      </button>
    </section>
  </aside>
</template>
