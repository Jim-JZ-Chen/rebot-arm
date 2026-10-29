import { execFile } from 'node:child_process'
import net from 'node:net'

const SERVICES = {
  can: 'rebot-can.service',
  driver: 'rebot-driver.service',
  rosbridge: 'rebot-rosbridge.service',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const trimOutput = (value) => String(value || '').trim().slice(-700)

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

function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label}失败${result.stderr ? `：${result.stderr}` : result.stdout ? `：${result.stdout}` : `，退出码 ${result.code ?? '未知'}`}`)
  }
  return result.stdout
}

async function isActive(service) {
  const result = await execute('/usr/bin/systemctl', ['is-active', '--quiet', service], 5000)
  return result.code === 0
}

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

async function startService(service) {
  requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'start', service], 20000), `启动 ${service}`)
  await waitFor(() => isActive(service), 12000)
  return `${service} 已运行`
}

async function stopService(service) {
  if (!await isActive(service)) return `${service} 已处于停止状态`
  requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', service], 25000), `停止 ${service}`)
  await waitFor(async () => !(await isActive(service)), 12000)
  return `${service} 已停止`
}

function rosNamespace() {
  const namespace = process.env.REBOT_NAMESPACE || '/rebotarm'
  if (!/^\/[A-Za-z0-9_/-]+$/.test(namespace)) throw new Error('REBOT_NAMESPACE 格式无效')
  return namespace.replace(/\/+$/, '')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

async function runRos(command, timeout = 15000) {
  const workspace = process.env.REBOT_WORKSPACE
  if (!workspace) throw new Error('未配置 REBOT_WORKSPACE')
  const setup = `${shellQuote(workspace)}/install/setup.bash`
  const script = `set -e; source /opt/ros/jazzy/setup.bash; source ${setup}; ${command}`
  const result = await execute('/bin/bash', ['-lc', script], timeout)
  requireSuccess(result, 'ROS 命令')
  return `${result.stdout}\n${result.stderr}`.trim()
}

async function callTrigger(name, timeout) {
  const namespace = rosNamespace()
  const output = await runRos(`ros2 service call ${namespace}/${name} std_srvs/srv/Trigger '{}'`, timeout)
  if (!/success\s*[=:]\s*true/i.test(output)) {
    throw new Error(`${name} 未返回成功：${output.slice(-500) || '无响应内容'}`)
  }
  const message = output.match(/message\s*[=:]\s*['"]([^'"]+)['"]/i)?.[1]
  return message || `${namespace}/${name} 返回成功`
}

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
          const output = await runRos(`ros2 topic echo --once ${namespace}/joint_states sensor_msgs/msg/JointState`, 18000)
          if (!/name\s*:/.test(output) || !/position\s*:/.test(output)) {
            throw new Error('收到的 joint_states 内容不完整')
          }
          return { detail: `已收到 ${namespace}/joint_states 实际关节反馈` }
        }
        case 'shutdown-check': {
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
          requireSuccess(await execute('/usr/bin/sudo', ['-n', '/usr/sbin/shutdown', '-h', 'now'], 10000), '主机关机请求')
          return { detail: '主机关机命令已接受，连接即将中断' }
        default:
          throw new Error(`未知步骤：${stepId}`)
      }
    },
  }
}
