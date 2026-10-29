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

export function stepSummary(step: SequenceStep) {
  if (step.type === 'joint') return `${step.duration.toFixed(1)} s · ${step.positions.map(formatDeg).join(' / ')}`
  if (step.type === 'gripper') return step.action === 'open' ? 'GRIPPER OPEN' : 'GRIPPER CLOSE'
  if (step.type === 'wait') return `${step.duration.toFixed(1)} s`
  return 'SAFE HOME'
}
