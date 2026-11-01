import * as ROSLIB from 'roslib'
import { JOINT_NAMES } from './robot'
import type { Quaternion, TrafficEvent } from './robot'

interface RosEvents {
  onConnection: (state: 'connected' | 'disconnected' | 'error', detail?: string) => void
  onJoints: (positions: number[], gripperRaw?: number) => void
  onArmStatus: (status: Record<string, unknown>) => void
  onTraffic?: (event: TrafficEvent) => void
}

interface JointStateMessage {
  name?: string[]
  position?: number[]
}

interface TrajectoryGoal {
  trajectory: {
    joint_names: string[]
    points: Array<{
      positions: number[]
      time_from_start: { sec: number; nanosec: number }
    }>
  }
}

interface TrajectoryResult {
  error_code?: number
  error_string?: string
}

interface PoseGoal {
  target_pose: {
    position: { x: number; y: number; z: number }
    orientation: Quaternion
  }
  duration: number
}

interface PoseResult {
  success?: boolean
  message?: string
  final_pose?: unknown
}

interface GripperCommandGoal {
  command: {
    position: number
    max_effort: number
  }
}

interface GripperActionResult {
  position?: number
  effort?: number
  stalled?: boolean
  reached_goal?: boolean
}

export class RebotRosClient {
  private ros: ROSLIB.Ros | null = null
  private namespace = '/rebotarm'
  private jointTopic: ROSLIB.Topic<JointStateMessage> | null = null
  private statusTopic: ROSLIB.Topic<Record<string, unknown>> | null = null
  private cancelActive: (() => void) | null = null
  private traffic: ((event: TrafficEvent) => void) | null = null
  private callSeq = 0

  connect(url: string, namespace: string, events: RosEvents) {
    this.disconnect()
    this.namespace = normalizeNamespace(namespace)
    this.traffic = events.onTraffic || null
    const ros = new ROSLIB.Ros({ url })
    this.ros = ros

    ros.on('connection', () => {
      events.onConnection('connected')
      this.subscribe(events)
    })
    ros.on('close', () => events.onConnection('disconnected'))
    ros.on('error', (error: unknown) => {
      const detail =
        error instanceof Error
          ? error.message
          : 'WebSocket 握手失败，请确认 rosbridge 已启动且地址、端口正确'
      events.onConnection('error', detail)
    })
  }

  private subscribe(events: RosEvents) {
    if (!this.ros) return
    this.jointTopic = new ROSLIB.Topic<JointStateMessage>({
      ros: this.ros,
      name: `${this.namespace}/joint_states`,
      messageType: 'sensor_msgs/msg/JointState',
      throttle_rate: 50,
      queue_length: 1,
    })
    this.jointTopic.subscribe((msg) => {
      this.traffic?.({
        kind: 'topic',
        name: `${this.namespace}/joint_states`,
        messageType: 'sensor_msgs/msg/JointState',
        message: msg,
        at: Date.now(),
      })
      if (!msg.name || !msg.position) return
      const positions = JOINT_NAMES.map((name) => {
        const index = msg.name!.indexOf(name)
        return index >= 0 ? Number(msg.position![index]) || 0 : 0
      })
      const gripperIndex = msg.name.findIndex((name) =>
        ['gripper', 'gripper_joint', 'gripper_joint1'].includes(name),
      )
      let gripperRaw: number | undefined
      if (gripperIndex >= 0) {
        const value = msg.position[gripperIndex]
        gripperRaw = msg.name[gripperIndex] === 'gripper_joint1' ? (value / 0.05) * 5 : value
      }
      events.onJoints(positions, gripperRaw)
    })

    this.statusTopic = new ROSLIB.Topic<Record<string, unknown>>({
      ros: this.ros,
      name: `${this.namespace}/arm_status`,
      messageType: 'rebotarm_msgs/msg/ArmStatus',
      throttle_rate: 100,
      queue_length: 1,
    })
    this.statusTopic.subscribe((message) => {
      this.traffic?.({
        kind: 'topic',
        name: `${this.namespace}/arm_status`,
        messageType: 'rebotarm_msgs/msg/ArmStatus',
        message,
        at: Date.now(),
      })
      events.onArmStatus(message)
    })
  }

  private async callService(name: string, type: string, request: Record<string, unknown>, timeout = 12000): Promise<void> {
    if (!this.ros) throw new Error('尚未连接 rosbridge')
    const ros = this.ros
    const callId = ++this.callSeq
    const startedAt = Date.now()
    this.traffic?.({ kind: 'call-start', id: callId, category: 'service', name, type, request, at: startedAt })
    const service = new ROSLIB.Service<Record<string, unknown>, { success?: boolean; message?: string }>({
      ros,
      name,
      serviceType: type,
    })
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.traffic?.({
          kind: 'call-end',
          id: callId,
          status: 'error',
          error: `服务调用超时：${name}`,
          durationMs: Date.now() - startedAt,
        })
        reject(new Error(`服务调用超时：${name}`))
      }, timeout)
      service.callService(
        request,
        (result) => {
          window.clearTimeout(timer)
          const failed = result.success === false
          this.traffic?.({
            kind: 'call-end',
            id: callId,
            status: failed ? 'error' : 'success',
            response: result,
            error: failed ? result.message || `服务返回失败：${name}` : undefined,
            durationMs: Date.now() - startedAt,
          })
          if (failed) reject(new Error(result.message || `服务返回失败：${name}`))
          else resolve()
        },
        (error: string) => {
          window.clearTimeout(timer)
          this.traffic?.({
            kind: 'call-end',
            id: callId,
            status: 'error',
            error: error || `服务调用失败：${name}`,
            durationMs: Date.now() - startedAt,
          })
          reject(new Error(error || `服务调用失败：${name}`))
        },
      )
    })
  }

  /**
   * 发送一个 Action goal 并等待结果，统一处理超时、取消和流量上报。
   * interpret 返回 null 表示成功，返回字符串表示业务失败原因。
   */
  private runAction<TGoal, TResult>(
    name: string,
    actionType: string,
    goal: TGoal,
    timeoutMs: number,
    interpret: (result: TResult | undefined) => string | null,
  ): Promise<void> {
    if (!this.ros) return Promise.reject(new Error('尚未连接 rosbridge'))
    this.cancelTrajectory()
    const ros = this.ros
    const action = new ROSLIB.Action<TGoal, unknown, TResult>({ ros, name, actionType })
    const callId = ++this.callSeq
    const startedAt = Date.now()
    this.traffic?.({ kind: 'call-start', id: callId, category: 'action', name, type: actionType, request: goal, at: startedAt })
    const endTraffic = (status: 'success' | 'error', response?: unknown, error?: string) => {
      this.traffic?.({ kind: 'call-end', id: callId, status, response, error, durationMs: Date.now() - startedAt })
    }

    return new Promise<void>((resolve, reject) => {
      let goalId: string | undefined
      const finish = () => {
        window.clearTimeout(timer)
        if (goalId) ros.off(goalId)
        this.cancelActive = null
      }
      const timer = window.setTimeout(() => {
        if (goalId) action.cancelGoal(goalId)
        finish()
        endTraffic('error', undefined, '动作执行超时，已请求取消')
        reject(new Error('动作执行超时，已请求取消'))
      }, timeoutMs)

      goalId = action.sendGoal(
        goal,
        (result) => {
          finish()
          const error = interpret(result)
          endTraffic(error ? 'error' : 'success', result, error || undefined)
          if (error) reject(new Error(error))
          else resolve()
        },
        undefined,
        (error) => {
          finish()
          endTraffic('error', undefined, error || '动作目标被动作服务器拒绝')
          reject(new Error(error || '动作目标被动作服务器拒绝'))
        },
      )
      if (!goalId) {
        finish()
        endTraffic('error', undefined, '无法发送动作目标')
        reject(new Error('无法发送动作目标'))
        return
      }
      this.cancelActive = () => {
        if (goalId) action.cancelGoal(goalId)
        finish()
        endTraffic('error', undefined, '任务已取消')
        reject(new Error('任务已取消'))
      }
    })
  }

  enable() {
    return this.callService(`${this.namespace}/enable`, 'std_srvs/srv/Trigger', {})
  }

  disable() {
    return this.callService(`${this.namespace}/disable`, 'std_srvs/srv/Trigger', {}, 20000)
  }

  safeHome() {
    return this.callService(`${this.namespace}/safe_home`, 'std_srvs/srv/Trigger', {}, 30000)
  }

  /**
   * 经标准 control_msgs/action/GripperCommand 控制夹爪开度（0 = 闭合，5 = 张开，单位 rad）。
   * 驱动侧位置控制循环最长执行约 5 秒，超时上限留足余量。
   */
  setGripper(position: number, maxEffort = 0) {
    const goal: GripperCommandGoal = { command: { position, max_effort: maxEffort } }
    return this.runAction<GripperCommandGoal, GripperActionResult>(
      `${this.namespace}/gripper/command`,
      'control_msgs/action/GripperCommand',
      goal,
      25000,
      (result) => {
        if (!result) return null
        if (result.reached_goal === false) {
          const actual = typeof result.position === 'number' ? result.position.toFixed(2) : '未知'
          return result.stalled
            ? `夹爪堵转，未到达目标（实际位置 ${actual}）`
            : `夹爪未在限时内到达目标（实际位置 ${actual}）`
        }
        return null
      },
    )
  }

  sendTrajectory(positions: number[], duration: number) {
    const seconds = Math.max(0.2, duration)
    const goal: TrajectoryGoal = {
      trajectory: {
        joint_names: [...JOINT_NAMES],
        points: [{
          positions,
          time_from_start: {
            sec: Math.floor(seconds),
            nanosec: Math.floor((seconds % 1) * 1e9),
          },
        }],
      },
    }
    return this.runAction<TrajectoryGoal, TrajectoryResult>(
      `${this.namespace}/follow_joint_trajectory`,
      'control_msgs/action/FollowJointTrajectory',
      goal,
      seconds * 1000 + 20000,
      (result) =>
        typeof result?.error_code === 'number' && result.error_code !== 0
          ? result?.error_string || `轨迹失败，错误码 ${result?.error_code}`
          : null,
    )
  }

  moveToPose(position: number[], orientation: Quaternion, duration: number) {
    const seconds = Math.max(0.2, duration)
    const goal: PoseGoal = {
      target_pose: {
        position: { x: position[0], y: position[1], z: position[2] },
        orientation,
      },
      duration: seconds,
    }
    return this.runAction<PoseGoal, PoseResult>(
      `${this.namespace}/move_to_pose`,
      'rebotarm_msgs/action/MoveToPose',
      goal,
      seconds * 1000 + 20000,
      (result) => (result && result.success === false ? result.message || '末端位姿执行失败' : null),
    )
  }

  cancelTrajectory() {
    this.cancelActive?.()
  }

  disconnect() {
    this.cancelTrajectory()
    this.jointTopic?.unsubscribe()
    this.statusTopic?.unsubscribe()
    this.jointTopic = null
    this.statusTopic = null
    this.traffic = null
    if (this.ros) {
      this.ros.close()
      this.ros = null
    }
  }
}

function normalizeNamespace(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return '/rebotarm'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}
