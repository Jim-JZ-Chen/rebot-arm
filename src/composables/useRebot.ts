import { onBeforeUnmount, ref } from 'vue'
import { RebotRosClient } from '@/lib/rosClient'
import type { ArmStatus, ConnectionState, InterfaceCall, LogEntry, LogLevel, RunState, SequenceStep, TopicStat, TrafficEvent } from '@/lib/robot'
import { READY_POSE, ZERO_POSE, rpyToQuat } from '@/lib/robot'

const initialLog: LogEntry = {
  id: 1,
  time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  message: '浏览器演示已就绪；连接 ROS 2 前不会发送任何硬件命令。',
  level: 'info',
}

function previewJson(value: unknown, max = 800) {
  try {
    const text = JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch {
    return String(value)
  }
}

export function useRebot() {
  const client = new RebotRosClient()
  let busy = false
  let generation = 0
  let demoReject: ((reason: Error) => void) | null = null
  let feedbackTimes: number[] = []
  let currentSnapshot = [...READY_POSE]
  const topicBuffer = new Map<string, { messageType: string; count: number; times: number[]; lastAt: number; lastMessage: unknown }>()
  let topicFlushTimer: number | undefined

  const mode = ref<'demo' | 'ros'>('demo')
  const connection = ref<ConnectionState>('disconnected')
  const url = ref(localStorage.getItem('rebot.rosbridge.url') || 'ws://localhost:9090')
  const namespace = ref(localStorage.getItem('rebot.namespace') || '/rebotarm')
  const current = ref<number[]>([...READY_POSE])
  const target = ref<number[]>([...READY_POSE])
  const gripperRaw = ref(5)
  const armStatus = ref<ArmStatus>({ enabled: true, state_machine: 'DEMO', error_code: 0 })
  const runState = ref<RunState>('idle')
  const activeStep = ref<number | null>(null)
  const logs = ref<LogEntry[]>([initialLog])
  const feedbackRate = ref(0)
  const lastFeedback = ref<number | null>(null)
  const safetyConfirmed = ref(false)
  const topicStats = ref<TopicStat[]>([])
  const interfaceCalls = ref<InterfaceCall[]>([])

  const updateCurrent = (positions: number[]) => {
    currentSnapshot = [...positions]
    current.value = positions
  }

  const appendLog = (message: string, level: LogLevel = 'info') => {
    logs.value = [
      ...logs.value.slice(-79),
      {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        message,
        level,
      },
    ]
  }

  const clearLogs = () => {
    logs.value = []
  }

  const flushTopics = () => {
    topicFlushTimer = undefined
    const now = Date.now()
    topicStats.value = [...topicBuffer.entries()].map(([name, stat]) => {
      stat.times = stat.times.filter((time) => now - time < 2000)
      return {
        name,
        messageType: stat.messageType,
        count: stat.count,
        rate: Math.round((stat.times.length / 2) * 10) / 10,
        lastAt: stat.lastAt,
        lastMessage: previewJson(stat.lastMessage),
      }
    })
  }

  const resetTopicStats = () => {
    topicBuffer.clear()
    if (topicFlushTimer !== undefined) {
      window.clearTimeout(topicFlushTimer)
      topicFlushTimer = undefined
    }
    topicStats.value = []
  }

  const handleTraffic = (event: TrafficEvent) => {
    if (event.kind === 'topic') {
      const stat = topicBuffer.get(event.name) || { messageType: event.messageType, count: 0, times: [], lastAt: 0, lastMessage: null }
      stat.count += 1
      stat.times.push(event.at)
      stat.lastAt = event.at
      stat.lastMessage = event.message
      topicBuffer.set(event.name, stat)
      if (topicFlushTimer === undefined) topicFlushTimer = window.setTimeout(flushTopics, 400)
      return
    }
    if (event.kind === 'call-start') {
      interfaceCalls.value = [
        {
          id: event.id,
          category: event.category,
          name: event.name,
          type: event.type,
          request: previewJson(event.request),
          status: 'pending',
          response: '',
          startedAt: event.at,
        },
        ...interfaceCalls.value.slice(0, 39),
      ]
      return
    }
    interfaceCalls.value = interfaceCalls.value.map((call) =>
      call.id === event.id
        ? {
            ...call,
            status: event.status,
            response: event.error || previewJson(event.response ?? null),
            durationMs: event.durationMs,
          }
        : call,
    )
  }

  const clearInterfaceLog = () => {
    interfaceCalls.value = []
  }

  const disconnect = () => {
    generation += 1
    demoReject?.(new Error('连接已断开'))
    demoReject = null
    client.disconnect()
    busy = false
    connection.value = 'disconnected'
    feedbackRate.value = 0
    lastFeedback.value = null
    runState.value = 'idle'
    activeStep.value = null
    resetTopicStats()
  }

  const connect = () => {
    const trimmedUrl = url.value.trim()
    const trimmedNamespace = namespace.value.trim()
    if (!/^wss?:\/\//.test(trimmedUrl)) {
      connection.value = 'error'
      appendLog('rosbridge 地址必须以 ws:// 或 wss:// 开头。', 'error')
      return
    }
    localStorage.setItem('rebot.rosbridge.url', trimmedUrl)
    localStorage.setItem('rebot.namespace', trimmedNamespace)
    mode.value = 'ros'
    safetyConfirmed.value = false
    armStatus.value = {}
    connection.value = 'connecting'
    appendLog(`正在连接 ${trimmedUrl} …`)
    try {
      client.connect(trimmedUrl, trimmedNamespace, {
        onConnection: (state, detail) => {
          connection.value = state
          if (state === 'connected') appendLog(`rosbridge 已连接，命名空间 ${trimmedNamespace}。`, 'success')
          if (state === 'disconnected') appendLog('rosbridge 连接已关闭。', 'warning')
          if (state === 'error') appendLog(`连接错误：${detail || '请检查 rosbridge 是否已启动'}`, 'error')
        },
        onJoints: (positions, rawGripper) => {
          updateCurrent(positions)
          if (typeof rawGripper === 'number') gripperRaw.value = rawGripper
          const now = performance.now()
          feedbackTimes = [...feedbackTimes.filter((time) => now - time < 1000), now]
          feedbackRate.value = feedbackTimes.length
          lastFeedback.value = Date.now()
        },
        onArmStatus: (status) => {
          armStatus.value = status
        },
        onTraffic: handleTraffic,
      })
    } catch (error) {
      connection.value = 'error'
      appendLog(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const switchMode = (next: 'demo' | 'ros') => {
    disconnect()
    mode.value = next
    safetyConfirmed.value = false
    if (next === 'demo') {
      updateCurrent([...READY_POSE])
      target.value = [...READY_POSE]
      gripperRaw.value = 5
      armStatus.value = { enabled: true, state_machine: 'DEMO', error_code: 0 }
      appendLog('已切换到浏览器演示；所有运动仅在本地模拟。')
    } else {
      armStatus.value = {}
      appendLog('已切换到 ROS 2 模式，请连接本机 rosbridge。')
    }
  }

  const ensureMotionAllowed = () => {
    if (mode.value === 'demo') return
    if (connection.value !== 'connected') throw new Error('请先连接 rosbridge')
    if (!safetyConfirmed.value) throw new Error('请先确认工作区无人、无障碍且物理急停可用')
  }

  const demoTrajectory = (positions: number[], duration: number, token: number) => {
    return new Promise<void>((resolve, reject) => {
      const start = [...currentSnapshot]
      const startedAt = performance.now()
      // 与驱动端一致：按真实时长做关节空间线性插值（ros_actions.py 的 ratio 逻辑）
      const demoDuration = Math.max(0.2, duration) * 1000
      demoReject = reject
      const frame = (now: number) => {
        if (generation !== token) {
          demoReject = null
          reject(new Error('任务已取消'))
          return
        }
        const ratio = Math.min(1, (now - startedAt) / demoDuration)
        updateCurrent(start.map((value, index) => value + (positions[index] - value) * ratio))
        if (ratio < 1) {
          requestAnimationFrame(frame)
        } else {
          demoReject = null
          updateCurrent(positions)
          resolve()
        }
      }
      requestAnimationFrame(frame)
    })
  }

  const performTrajectory = async (positions: number[], duration: number, token: number) => {
    ensureMotionAllowed()
    if (mode.value === 'demo') await demoTrajectory(positions, duration, token)
    else await client.sendTrajectory(positions, duration)
    if (generation !== token) throw new Error('任务已取消')
  }

  const delay = (seconds: number, token: number) => {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        demoReject = null
        if (generation !== token) reject(new Error('任务已取消'))
        else resolve()
      }, Math.max(0, seconds * 1000))
      demoReject = (reason) => {
        window.clearTimeout(timer)
        reject(reason)
      }
    })
  }

  const performGripper = async (position: number, token: number) => {
    ensureMotionAllowed()
    const target = Math.max(0, Math.min(5, position))
    if (mode.value === 'demo') {
      await delay(0.55, token)
      if (generation === token) gripperRaw.value = target
    } else {
      await client.setGripper(target)
    }
    if (generation !== token) throw new Error('任务已取消')
  }

  const performHome = async (token: number) => {
    ensureMotionAllowed()
    if (mode.value === 'demo') await demoTrajectory(ZERO_POSE, 3, token)
    else await client.safeHome()
    if (generation !== token) throw new Error('任务已取消')
  }

  const performPose = async (step: Extract<SequenceStep, { type: 'pose' }>, token: number) => {
    ensureMotionAllowed()
    if (mode.value === 'demo') {
      // 演示模式无 IK 能力，机械臂保持不动，仅按真实时长模拟执行耗时
      await delay(step.duration, token)
    } else {
      await client.moveToPose(step.position, rpyToQuat(step.rpy), step.duration)
    }
    if (generation !== token) throw new Error('任务已取消')
  }

  const beginTask = () => {
    if (busy) throw new Error('已有任务正在执行')
    busy = true
    generation += 1
    runState.value = 'running'
    return generation
  }

  const endTask = (token: number, state: RunState) => {
    if (generation !== token) return
    busy = false
    runState.value = state
    activeStep.value = null
  }

  const executeTrajectory = async (positions = target.value, duration = 3) => {
    let token = 0
    try {
      ensureMotionAllowed()
      token = beginTask()
      appendLog(`开始执行关节轨迹，时长 ${duration.toFixed(1)} 秒。`)
      await performTrajectory(positions, duration, token)
      endTask(token, 'success')
      appendLog('关节轨迹执行完成。', 'success')
    } catch (error) {
      if (token) endTask(token, 'error')
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const runSingleService = async (kind: 'enable' | 'disable' | 'home' | 'open' | 'close') => {
    let token = 0
    try {
      ensureMotionAllowed()
      token = beginTask()
      const labels = { enable: '启用机械臂', disable: '安全禁用', home: '安全回零', open: '张开夹爪', close: '闭合夹爪' }
      appendLog(`请求：${labels[kind]}。`)
      if (kind === 'enable') {
        if (mode.value === 'demo') await delay(0.35, token)
        else await client.enable()
        if (mode.value === 'demo') armStatus.value = { ...armStatus.value, enabled: true }
      } else if (kind === 'disable') {
        if (mode.value === 'demo') await demoTrajectory(ZERO_POSE, 2, token)
        else await client.disable()
        if (mode.value === 'demo') armStatus.value = { ...armStatus.value, enabled: false }
      } else if (kind === 'home') {
        await performHome(token)
      } else {
        await performGripper(kind === 'open' ? 5 : 0, token)
      }
      endTask(token, 'success')
      appendLog(`${labels[kind]}完成。`, 'success')
    } catch (error) {
      if (token) endTask(token, 'error')
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const runGripper = async (position: number) => {
    let token = 0
    try {
      ensureMotionAllowed()
      token = beginTask()
      appendLog(`请求：夹爪开到 ${position.toFixed(1)} / 5。`)
      await performGripper(position, token)
      endTask(token, 'success')
      appendLog('夹爪到位。', 'success')
    } catch (error) {
      if (token) endTask(token, 'error')
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const runSequence = async (steps: SequenceStep[]) => {
    if (!steps.length) {
      appendLog('序列为空，请先添加步骤。', 'warning')
      return
    }
    let token = 0
    try {
      ensureMotionAllowed()
      token = beginTask()
      appendLog(`开始执行序列，共 ${steps.length} 步。`)
      for (let index = 0; index < steps.length; index += 1) {
        if (generation !== token) throw new Error('任务已取消')
        activeStep.value = index
        const step = steps[index]
        appendLog(`步骤 ${index + 1}/${steps.length}：${step.name}`)
        if (step.type === 'joint') await performTrajectory(step.positions, step.duration, token)
        if (step.type === 'pose') await performPose(step, token)
        if (step.type === 'gripper') await performGripper(step.position ?? (step.action === 'close' ? 0 : 5), token)
        if (step.type === 'wait') await delay(step.duration, token)
        if (step.type === 'home') await performHome(token)
      }
      endTask(token, 'success')
      appendLog('动作序列全部完成。', 'success')
    } catch (error) {
      if (token) endTask(token, 'error')
      appendLog(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const cancelTask = () => {
    if (!busy) return
    generation += 1
    client.cancelTrajectory()
    demoReject?.(new Error('任务已取消'))
    demoReject = null
    busy = false
    runState.value = 'cancelling'
    activeStep.value = null
    appendLog('已取消网页任务；这不是物理急停。', 'warning')
  }

  onBeforeUnmount(() => {
    generation += 1
    demoReject?.(new Error('面板已关闭'))
    if (topicFlushTimer !== undefined) window.clearTimeout(topicFlushTimer)
    client.disconnect()
  })

  return {
    mode,
    connection,
    url,
    namespace,
    current,
    target,
    gripperRaw,
    armStatus,
    runState,
    activeStep,
    logs,
    feedbackRate,
    lastFeedback,
    safetyConfirmed,
    topicStats,
    interfaceCalls,
    clearLogs,
    clearInterfaceLog,
    connect,
    disconnect,
    switchMode,
    executeTrajectory,
    runSingleService,
    runGripper,
    runSequence,
    cancelTask,
  }
}
