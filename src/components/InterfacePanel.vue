<template>
  <section class="interface-panel" aria-label="ROS 接口流量监控">
    <div class="iface-header">
      <div class="iface-title">
        <Activity :size="16" />
        <strong>连接层 · 接口流量</strong>
        <span class="iface-state" :class="`state-${stateClass}`">{{ stateLabel }}</span>
      </div>
      <span class="iface-note">本页面经 rosbridge 实际收发的 Topic / Service / Action</span>
      <button type="button" class="iface-clear" :disabled="!calls.length" @click="$emit('clear')">清空调用记录</button>
    </div>

    <div class="iface-grid">
      <div class="iface-column">
        <h3>TOPIC 订阅</h3>
        <div v-for="topic in topics" :key="topic.name" class="iface-topic">
          <div class="iface-topic-head">
            <span class="iface-badge badge-topic">TOPIC</span>
            <strong>{{ topic.name }}</strong>
            <span class="iface-metrics">{{ topic.rate }} Hz · {{ topic.count }} 条 · {{ formatTime(topic.lastAt) }}</span>
          </div>
          <div class="iface-type">{{ topic.messageType }}</div>
          <pre class="iface-pre">{{ topic.lastMessage }}</pre>
        </div>
        <div v-if="!topics.length" class="iface-empty">{{ topicsEmptyHint }}</div>
      </div>

      <div class="iface-column">
        <h3>SERVICE / ACTION 调用</h3>
        <div v-for="call in calls" :key="call.id" class="iface-call" :class="`call-${call.status}`">
          <div class="iface-call-head">
            <span class="iface-badge" :class="call.category === 'action' ? 'badge-action' : 'badge-service'">
              {{ call.category === 'action' ? 'ACTION' : 'SERVICE' }}
            </span>
            <strong>{{ call.name }}</strong>
            <span class="iface-status">
              <LoaderCircle v-if="call.status === 'pending'" :size="11" class="spin" />
              <Check v-else-if="call.status === 'success'" :size="11" />
              <X v-else :size="11" />
              {{ statusLabel[call.status] }}
            </span>
            <span class="iface-metrics">{{ formatTime(call.startedAt) }} · {{ formatDuration(call) }}</span>
          </div>
          <div class="iface-type">{{ call.type }}</div>
          <div class="iface-call-body">
            <div>
              <small>请求</small>
              <pre class="iface-pre">{{ call.request }}</pre>
            </div>
            <div v-if="call.status !== 'pending'">
              <small>{{ call.status === 'error' ? '错误' : '返回' }}</small>
              <pre class="iface-pre">{{ call.response }}</pre>
            </div>
          </div>
        </div>
        <div v-if="!calls.length" class="iface-empty">{{ callsEmptyHint }}</div>
      </div>
    </div>
  </section>
</template>


<script lang="ts">
import { defineComponent } from 'vue'
import type { PropType } from 'vue'
import { Activity, Check, LoaderCircle, X } from '@lucide/vue'
import type { ConnectionState, InterfaceCall, TopicStat } from '@/lib/robot'

export default defineComponent({
  name: 'InterfacePanel',
  components: { Activity, Check, LoaderCircle, X },
  props: {
    mode: { type: String as PropType<'demo' | 'ros'>, required: true },
    connection: { type: String as PropType<ConnectionState>, required: true },
    topics: { type: Array as PropType<TopicStat[]>, required: true },
    calls: { type: Array as PropType<InterfaceCall[]>, required: true },
  },
  emits: ['clear'],
  data() {
    return {
      statusLabel: {
        pending: '执行中',
        success: '成功',
        error: '失败',
      } as Record<InterfaceCall['status'], string>,
    }
  },
  computed: {
    stateClass(): string {
      return this.mode === 'demo' ? 'demo' : this.connection
    },
    stateLabel(): string {
      if (this.mode === 'demo') return '演示模式'
      return ({
        connected: '已连接',
        connecting: '连接中',
        disconnected: '未连接',
        error: '连接异常',
      })[this.connection]
    },
    topicsEmptyHint(): string {
      if (this.mode === 'demo') return '演示模式不产生 ROS 流量；切换到 ROS 2 目标并连接后，这里显示订阅的 topic。'
      if (this.connection === 'connected') return '等待 topic 数据…'
      return '连接 rosbridge 后显示订阅中的 topic。'
    },
    callsEmptyHint(): string {
      if (this.mode === 'demo') return '演示模式的运行为本地模拟，不会产生 Service / Action 调用。'
      return '尚无调用。点击启用、回零、夹爪或执行轨迹后，这里记录每次调用的请求与返回。'
    },
  },
  methods: {
    formatTime(at: number) {
      return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
    },
    formatDuration(call: InterfaceCall) {
      if (call.durationMs === undefined) return '等待结果…'
      if (call.durationMs >= 1000) return `${(call.durationMs / 1000).toFixed(2)} s`
      return `${Math.round(call.durationMs)} ms`
    },
  },
})
</script>
