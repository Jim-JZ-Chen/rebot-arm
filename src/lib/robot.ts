export const JOINT_NAMES = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6'] as const

export const JOINT_LIMITS = [
  [-2.8, 2.8],
  [0, 3.14],
  [0, 3.14],
  [-1.57, 1.57],
  [-1.57, 1.57],
  [-3.14, 3.14],
] as const

export const ZERO_POSE = [0, 0, 0, 0, 0, 0]
export const READY_POSE = [0, 0.75, 0.55, 0, 0, 0]
export const OBSERVE_POSE = [0.35, 1.05, 0.7, -0.35, 0.25, -0.4]
export const DEFAULT_POSE_POSITION = [0.3, 0, 0.3]
export const DEFAULT_POSE_RPY = [0, 0, 0]

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'
export type RunState = 'idle' | 'running' | 'cancelling' | 'success' | 'error'
export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface LogEntry {
  id: number
  time: string
  message: string
  level: LogLevel
}

export type SequenceStep =
  | { id: string; type: 'joint'; name: string; positions: number[]; duration: number }
  | { id: string; type: 'pose'; name: string; position: number[]; rpy: number[]; duration: number }
  | { id: string; type: 'gripper'; name: string; action: 'open' | 'close' }
  | { id: string; type: 'wait'; name: string; duration: number }
  | { id: string; type: 'home'; name: string }

export interface ArmStatus {
  enabled?: boolean
  state_machine?: string
  error_code?: number | string
  control_mode?: string
  [key: string]: unknown
}

export const DEFAULT_SEQUENCE: SequenceStep[] = [
  { id: 'step-ready', type: 'joint', name: '进入观察位', positions: OBSERVE_POSE, duration: 4 },
  { id: 'step-open', type: 'gripper', name: '张开夹爪', action: 'open' },
  { id: 'step-wait', type: 'wait', name: '等待稳定', duration: 0.8 },
  { id: 'step-close', type: 'gripper', name: '闭合夹爪', action: 'close' },
  { id: 'step-home', type: 'home', name: '安全回零' },
]

export const radToDeg = (value: number) => (value * 180) / Math.PI
export const degToRad = (value: number) => (value * Math.PI) / 180
export const clampJoint = (index: number, value: number) =>
  Math.min(JOINT_LIMITS[index][1], Math.max(JOINT_LIMITS[index][0], value))
export const formatDeg = (value: number) => `${radToDeg(value).toFixed(1)}°`
export const uid = () => `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

export interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

/** ZYX 欧拉角（rad）转四元数，与 ROS geometry_msgs/Pose 约定一致 */
export function rpyToQuat(rpy: number[]): Quaternion {
  const [roll, pitch, yaw] = rpy
  const cr = Math.cos(roll / 2)
  const sr = Math.sin(roll / 2)
  const cp = Math.cos(pitch / 2)
  const sp = Math.sin(pitch / 2)
  const cy = Math.cos(yaw / 2)
  const sy = Math.sin(yaw / 2)
  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  }
}

export function stepSummary(step: SequenceStep) {
  if (step.type === 'joint') return `${step.duration.toFixed(1)} s · ${step.positions.map(formatDeg).join(' / ')}`
  if (step.type === 'pose') return `${step.duration.toFixed(1)} s · XYZ ${step.position.map((v) => v.toFixed(2)).join(' / ')} m`
  if (step.type === 'gripper') return step.action === 'open' ? 'GRIPPER OPEN' : 'GRIPPER CLOSE'
  if (step.type === 'wait') return `${step.duration.toFixed(1)} s`
  return 'SAFE HOME'
}

// ---- 连接层流量监控 ----

/** Topic 收到一条消息（at 为接收时间戳 ms） */
export interface TopicTrafficEvent {
  kind: 'topic'
  name: string
  messageType: string
  message: unknown
  at: number
}

/** 一次 Service / Action 调用发起 */
export interface CallStartEvent {
  kind: 'call-start'
  id: number
  category: 'service' | 'action'
  name: string
  type: string
  request: unknown
  at: number
}

/** 一次 Service / Action 调用结束（成功或失败） */
export interface CallEndEvent {
  kind: 'call-end'
  id: number
  status: 'success' | 'error'
  response?: unknown
  error?: string
  durationMs: number
}

export type TrafficEvent = TopicTrafficEvent | CallStartEvent | CallEndEvent

/** 面板展示用：单个 topic 的聚合统计 */
export interface TopicStat {
  name: string
  messageType: string
  count: number
  rate: number
  lastAt: number
  lastMessage: string
}

/** 面板展示用：一次 Service / Action 调用记录 */
export interface InterfaceCall {
  id: number
  category: 'service' | 'action'
  name: string
  type: string
  request: string
  status: 'pending' | 'success' | 'error'
  response: string
  startedAt: number
  durationMs?: number
}
