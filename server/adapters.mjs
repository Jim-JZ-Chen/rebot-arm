// =============================================================================
// 系统操作适配层：为 index.mjs 的任务执行器提供"执行某个步骤"的能力。
//
// 导出两个工厂函数，对应两种运行模式：
//   createSystemdAdapter —— 真机模式：通过 sudo systemctl 起停三个固定服务，
//                            并用 ros2 CLI 检查接口、调用安全回零/禁用服务；
//   createMockAdapter    —— 模拟模式：只更新内存中的布尔状态并返回提示文本，
//                            完全不接触系统与硬件，用于无真机验证网页流程。
//
// 两个适配器暴露完全一致的接口：
//   mode            —— 模式名字符串（'systemd' | 'mock'）
//   getServices()   —— 返回 { can, driver, rosbridge } 三个服务的运行状态
//   runStep(stepId) —— 执行一个步骤，返回 { detail, skipped? }，失败时抛异常
// =============================================================================

import { execFile } from 'node:child_process'
import net from 'node:net'

// 三个受控 systemd 服务的固定名称（由 deploy/install.sh 安装）
const SERVICES = {
  can: 'rebot-can.service',
  driver: 'rebot-driver.service',
  rosbridge: 'rebot-rosbridge.service',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 截取命令输出的末尾 700 字符：错误信息通常在输出尾部，且避免超长输出撑爆响应
const trimOutput = (value) => String(value || '').trim().slice(-700)

// -----------------------------------------------------------------------------
// 用 execFile 执行外部命令并返回结构化结果 { code, stdout, stderr }。
// 关键点：
//   - 用 execFile + 参数数组而非 exec 拼接字符串，杜绝 Shell 注入；
//   - 永远 resolve（不 reject），把失败也变成正常结果，由调用方按退出码判断；
//   - 带超时与 1MB 输出上限，防止命令卡死或输出爆炸。
// -----------------------------------------------------------------------------
function execute(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr || error?.message),
      })
    })
  })
}

// 要求命令成功（退出码 0），否则抛出带 stderr/stdout 详情的错误
function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label}失败${result.stderr ? `：${result.stderr}` : result.stdout ? `：${result.stdout}` : `，退出码 ${result.code ?? '未知'}`}`)
  }
  return result.stdout
}

// 查询某个 systemd 服务是否处于 active 状态（is-active --quiet 退出码 0 即运行中）
async function isActive(service) {
  const result = await execute('/usr/bin/systemctl', ['is-active', '--quiet', service], 5000)
  return result.code === 0
}

// -----------------------------------------------------------------------------
// 轮询等待：反复调用 check() 直到返回真值或超时。
// check 抛出的异常会被记住，超时时优先抛出最后一次真实错误（信息更有用）。
// -----------------------------------------------------------------------------
async function waitFor(check, timeout, interval = 1000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw lastError || new Error(`等待状态就绪超时（${Math.round(timeout / 1000)} 秒）`)
}

// -----------------------------------------------------------------------------
// 启动一个 systemd 服务并等待其进入 active。
// sudo -n（--non-interactive）：不允许交互式询问密码——密码必须由
// deploy/rebot-launcher.sudoers 预授权；未授权会直接失败，而不是挂起等待输入。
// 服务名是常量，不在 sudoers 白名单内的命令根本不会被授权执行。
// -----------------------------------------------------------------------------
async function startService(service) {
  requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'start', service], 20000), `启动 ${service}`)
  await waitFor(() => isActive(service), 12000)
  return `${service} 已运行`
}

// 停止一个 systemd 服务并等待其退出；已停止时直接返回，保证幂等。
async function stopService(service) {
  if (!await isActive(service)) return `${service} 已处于停止状态`
  requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', service], 25000), `停止 ${service}`)
  await waitFor(async () => !(await isActive(service)), 12000)
  return `${service} 已停止`
}

// 读取 ROS 命名空间（默认 /rebotarm），并做严格格式校验：
// 该字符串稍后会拼进 bash 脚本，必须先白名单校验（字母/数字/下划线/斜杠/连字符），
// 再叠加 shellQuote，双重防护注入。
function rosNamespace() {
  const namespace = process.env.REBOT_NAMESPACE || '/rebotarm'
  if (!/^\/[A-Za-z0-9_/-]+$/.test(namespace)) throw new Error('REBOT_NAMESPACE 格式无效')
  return namespace.replace(/\/+$/, '')
}

// POSIX 单引号包裹的安全转义：把 ' 替换为 '"'"' 的标准写法
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

// -----------------------------------------------------------------------------
// 在完整的 ROS 环境中执行一条命令：
//   1. source ROS 2 Jazzy 系统环境；
//   2. source reBot 工作空间的 install/setup.bash（路径来自 REBOT_WORKSPACE，
//      由部署脚本写入 systemd unit，经 shellQuote 转义后拼接）；
//   3. set -e 让脚本中任一命令失败即整体失败。
// 通过 bash -lc 以登录 shell 执行，返回 stdout+stderr 合并文本。
// -----------------------------------------------------------------------------
async function runRos(command, timeout = 15000) {
  const workspace = process.env.REBOT_WORKSPACE
  if (!workspace) throw new Error('未配置 REBOT_WORKSPACE')
  const setup = `${shellQuote(workspace)}/install/setup.bash`
  const script = `set -e; source /opt/ros/jazzy/setup.bash; source ${setup}; ${command}`
  const result = await execute('/bin/bash', ['-lc', script], timeout)
  requireSuccess(result, 'ROS 命令')
  return `${result.stdout}\n${result.stderr}`.trim()
}

// -----------------------------------------------------------------------------
// 调用一个 std_srvs/srv/Trigger 类型的 ROS 服务（safe_home / disable）。
// 不只看进程退出码，还解析输出确认 success: true——服务可达但机械臂
// 拒绝执行时退出码仍是 0，必须检查业务结果。返回服务端的 message 文本。
// -----------------------------------------------------------------------------
async function callTrigger(name, timeout) {
  const namespace = rosNamespace()
  const output = await runRos(`ros2 service call ${namespace}/${name} std_srvs/srv/Trigger '{}'`, timeout)
  if (!/success\s*[=:]\s*true/i.test(output)) {
    throw new Error(`${name} 未返回成功：${output.slice(-500) || '无响应内容'}`)
  }
  const message = output.match(/message\s*[=:]\s*['"]([^'"]+)['"]/i)?.[1]
  return message || `${namespace}/${name} 返回成功`
}

// 探测本机某个 TCP 端口是否可连接（用于确认 rosbridge 的 9090 真的在监听），2.5 秒超时
function checkPort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 127.0.0.1:${port} 超时`))
    }, 2500)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// =============================================================================
// 模拟适配器
// 内存中的假服务状态。每个步骤 sleep 360ms 模拟耗时，让前端进度动画可观察。
// 设置环境变量 REBOT_MOCK_FAIL_STEP=<stepId> 可强制某一步失败，用于测试
// 前端的错误展示与"失败即中止"逻辑。
// =============================================================================
const mockServices = { can: false, driver: false, rosbridge: false }

export function createMockAdapter() {
  return {
    mode: 'mock',
    async getServices() {
      return { ...mockServices }
    },
    async runStep(stepId) {
      await sleep(360)
      if (process.env.REBOT_MOCK_FAIL_STEP === stepId) {
        throw new Error(`模拟步骤失败：${stepId}`)
      }
      switch (stepId) {
        case 'can-start':
          mockServices.can = true
          return { detail: 'CAN can0 已配置为 1 Mbps（模拟）' }
        case 'driver-start':
          mockServices.driver = true
          return { detail: 'reBot ROS 驱动已启动（模拟）' }
        case 'interfaces-check':
          // 模拟也保留真实的依赖约束：没启动驱动就不能通过接口检查
          if (!mockServices.driver) throw new Error('驱动尚未启动')
          return { detail: 'Topic、Service、Action 接口检查通过（模拟）' }
        case 'rosbridge-start':
          mockServices.rosbridge = true
          return { detail: 'rosbridge 已监听 9090（模拟）' }
        case 'feedback-check':
          if (!mockServices.driver) throw new Error('没有关节反馈')
          return { detail: '已收到 /rebotarm/joint_states（模拟）' }
        case 'shutdown-check':
          return { detail: mockServices.driver ? '驱动运行中，需要安全回零与禁用（模拟）' : '驱动未运行，无需调用安全服务（模拟）' }
        case 'safe-home':
          // 驱动未运行时跳过（skipped），与真机行为保持一致
          if (!mockServices.driver) return { detail: '驱动未运行，跳过安全回零', skipped: true }
          return { detail: '安全回零完成（模拟）' }
        case 'arm-disable':
          if (!mockServices.driver) return { detail: '驱动未运行，跳过禁用', skipped: true }
          return { detail: '机械臂已禁用（模拟）' }
        case 'driver-stop':
          mockServices.driver = false
          return { detail: 'ROS 驱动已停止（模拟）' }
        case 'rosbridge-stop':
          mockServices.rosbridge = false
          return { detail: 'rosbridge 已停止（模拟）' }
        case 'can-stop':
          mockServices.can = false
          return { detail: 'CAN 已关闭（模拟）' }
        case 'host-shutdown':
          mockServices.can = false
          mockServices.driver = false
          mockServices.rosbridge = false
          return { detail: 'ROS 主机关机命令已接受（模拟，不会真的关机）' }
        default:
          throw new Error(`未知步骤：${stepId}`)
      }
    },
  }
}

// =============================================================================
// systemd 适配器（真机模式）
// 步骤实现要点：
//   - 启停服务后都用 waitFor 轮询确认真实状态，而不是相信 systemctl 的返回；
//   - interfaces-check 轮询直到 enable/disable/safe_home 三个 Service 和
//     follow_joint_trajectory 一个 Action 全部出现（驱动启动后接口注册有延迟）；
//   - rosbridge-start 额外探测 9090 端口真实可连；
//   - feedback-check 真正 echo 一帧 joint_states 并校验内容包含 name/position；
//   - safe-home / arm-disable 在驱动未运行时标记 skipped，避免无谓失败；
//   - host-shutdown 调用 sudo shutdown -h now（同样依赖 sudoers 白名单）。
// =============================================================================
export function createSystemdAdapter() {
  return {
    mode: 'systemd',
    async getServices() {
      const [can, driver, rosbridge] = await Promise.all([
        isActive(SERVICES.can),
        isActive(SERVICES.driver),
        isActive(SERVICES.rosbridge),
      ])
      return { can, driver, rosbridge }
    },
    async runStep(stepId) {
      switch (stepId) {
        case 'can-start':
          return { detail: await startService(SERVICES.can) }
        case 'driver-start':
          return { detail: await startService(SERVICES.driver) }
        case 'interfaces-check': {
          const namespace = rosNamespace()
          await waitFor(async () => {
            const services = await runRos('ros2 service list', 10000)
            const actions = await runRos('ros2 action list', 10000)
            // 按行精确匹配，避免子串误判
            const requiredServices = ['enable', 'disable', 'safe_home'].every((name) => services.split('\n').includes(`${namespace}/${name}`))
            const actionReady = actions.split('\n').includes(`${namespace}/follow_joint_trajectory`)
            return requiredServices && actionReady
          }, 35000)
          return { detail: 'Enable、Disable、Safe Home 与轨迹 Action 均已发现' }
        }
        case 'rosbridge-start': {
          const detail = await startService(SERVICES.rosbridge)
          await waitFor(() => checkPort(9090), 15000)
          return { detail: `${detail}；9090 端口连接成功` }
        }
        case 'feedback-check': {
          const namespace = rosNamespace()
          // 真实读取一帧关节状态，验证数据链路端到端可用
          const output = await runRos(`ros2 topic echo --once ${namespace}/joint_states sensor_msgs/msg/JointState`, 18000)
          if (!/name\s*:/.test(output) || !/position\s*:/.test(output)) {
            throw new Error('收到的 joint_states 内容不完整')
          }
          return { detail: `已收到 ${namespace}/joint_states 实际关节反馈` }
        }
        case 'shutdown-check': {
          // 只检查不动作：告知用户后续安全步骤是否会真正执行
          const active = await isActive(SERVICES.driver)
          return { detail: active ? '驱动运行中，必须安全回零并禁用后再停止' : '驱动未运行，安全服务步骤将跳过' }
        }
        case 'safe-home':
          if (!await isActive(SERVICES.driver)) return { detail: '驱动未运行，跳过安全回零', skipped: true }
          return { detail: await callTrigger('safe_home', 45000) }
        case 'arm-disable':
          if (!await isActive(SERVICES.driver)) return { detail: '驱动未运行，跳过禁用', skipped: true }
          return { detail: await callTrigger('disable', 25000) }
        case 'driver-stop':
          return { detail: await stopService(SERVICES.driver) }
        case 'rosbridge-stop':
          return { detail: await stopService(SERVICES.rosbridge) }
        case 'can-stop':
          return { detail: await stopService(SERVICES.can) }
        case 'host-shutdown':
          // 请求整台主机关机；命令被接受后连接随即中断，属预期行为
          requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/sbin/shutdown', '-h', 'now'], 10000), '主机关机请求')
          return { detail: '主机关机命令已接受，连接即将中断' }
        default:
          throw new Error(`未知步骤：${stepId}`)
      }
    },
  }
}
