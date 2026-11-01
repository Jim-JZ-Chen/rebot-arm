// =============================================================================
// reBot 本地启动器（launcher）HTTP 服务入口
//
// 职责：
//   1. 托管前端构建产物（dist/ 静态文件），即用户打开的控制台页面；
//   2. 暴露 /api/system/* 接口，让网页可以分步启动 / 关闭机械臂软件系统与整台主机；
//   3. 维护"系统任务（job）"的队列与逐步执行状态，供前端轮询展示进度。
//
// 本文件只做 HTTP 层、任务编排和安全校验，具体的"每一步做什么"
// （起停 systemd 服务、调用 ROS 命令）全部委托给 adapters.mjs 中的适配器。
// =============================================================================

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockAdapter, createSystemdAdapter } from './adapters.mjs'

// 项目根目录（本文件位于 server/ 下，向上一级）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 前端构建产物目录（npm run build 的输出）
const distRoot = path.join(root, 'dist')

// 默认只监听回环地址，避免把系统操作接口暴露到局域网
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3000)

// 根据环境变量选择适配器：
//   systemd —— 真机模式，真正操作 systemd 服务和 ROS 命令（部署脚本会设置）；
//   其他/缺省 —— mock 模式，只更新内存状态，不触碰硬件，用于无真机验证界面。
const adapter = process.env.REBOT_LAUNCHER_MODE === 'systemd' ? createSystemdAdapter() : createMockAdapter()

// -----------------------------------------------------------------------------
// 三种系统操作的定义
// 每个操作包含：显示名 label、前端必须回传的确认字符串 confirmation、
// 以及按顺序执行的步骤列表 [步骤 id, 步骤显示名]。
// confirmation 的作用是防止误触 / 防止跨站请求伪造（CSRF）：
// 前端弹确认框后必须原样回传该字符串，服务端才会执行。
// -----------------------------------------------------------------------------
const OPERATIONS = {
  // 启动：CAN → 驱动 → 接口检查 → rosbridge → 关节反馈确认
  start: {
    label: '启动机械臂软件系统',
    confirmation: 'START',
    steps: [
      ['can-start', '配置 CAN 通道'],
      ['driver-start', '启动 ROS 驱动'],
      ['interfaces-check', '检查 ROS 接口'],
      ['rosbridge-start', '启动 rosbridge'],
      ['feedback-check', '检查关节反馈'],
    ],
  },
  // 关闭机械臂系统：先安全检查，再回零、禁用，最后逆序停服务
  shutdown: {
    label: '关闭机械臂系统',
    confirmation: 'ARM_SHUTDOWN',
    steps: [
      ['shutdown-check', '检查运行状态'],
      ['safe-home', '安全回零'],
      ['arm-disable', '禁用机械臂'],
      ['driver-stop', '停止 ROS 驱动'],
      ['rosbridge-stop', '停止 rosbridge'],
      ['can-stop', '关闭 CAN'],
    ],
  },
  // 关闭整台 ROS 主机：在完整关机流程之后追加主机关机命令
  host: {
    label: '关闭 ROS 主机',
    confirmation: 'HOST_SHUTDOWN',
    steps: [
      ['shutdown-check', '检查运行状态'],
      ['safe-home', '安全回零'],
      ['arm-disable', '禁用机械臂'],
      ['driver-stop', '停止 ROS 驱动'],
      ['rosbridge-stop', '停止 rosbridge'],
      ['can-stop', '关闭 CAN'],
      ['host-shutdown', '关闭 ROS 主机'],
    ],
  },
}

// 当前正在执行（或最近一次执行）的系统任务。
// 设计上同一时间只允许一个任务，避免启停操作互相打架。
let currentJob = null

// -----------------------------------------------------------------------------
// 顺序执行一个任务的所有步骤。
// 安全原则：任何一步失败立即中止，后续步骤不再执行（例如安全回零失败
// 就绝不能继续停驱动）。步骤结果为 skipped 时（如驱动本来没运行）记为跳过。
// 所有时间戳随执行过程更新，供前端轮询时渲染进度。
// -----------------------------------------------------------------------------
async function executeJob(job) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  for (const step of job.steps) {
    step.status = 'running'
    step.startedAt = new Date().toISOString()
    job.updatedAt = step.startedAt
    try {
      // 把步骤 id 交给适配器执行；返回 { detail, skipped? }
      const result = await adapter.runStep(step.id)
      step.status = result.skipped ? 'skipped' : 'success'
      step.detail = result.detail
      step.finishedAt = new Date().toISOString()
      job.updatedAt = step.finishedAt
    } catch (error) {
      // 当前步骤失败：标记错误并中止整个任务
      step.status = 'error'
      step.detail = error instanceof Error ? error.message : String(error)
      step.finishedAt = new Date().toISOString()
      job.status = 'error'
      job.error = `步骤“${step.name}”失败，后续步骤未执行。`
      job.updatedAt = step.finishedAt
      job.finishedAt = step.finishedAt
      return
    }
  }
  job.status = 'success'
  job.finishedAt = new Date().toISOString()
  job.updatedAt = job.finishedAt
}

// -----------------------------------------------------------------------------
// 创建一个新任务并异步启动执行。
// 若已有任务在跑则抛 409 冲突错误。任务对象立即返回（pending 状态），
// 实际执行通过 setImmediate 放到事件循环下一轮，避免阻塞 HTTP 响应。
// -----------------------------------------------------------------------------
function startJob(operation) {
  if (currentJob?.status === 'running') {
    const error = new Error('已有系统任务正在执行，请等待完成。')
    error.statusCode = 409
    throw error
  }
  const definition = OPERATIONS[operation]
  const job = {
    id: randomUUID(),
    operation,
    label: definition.label,
    launcherMode: adapter.mode,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: definition.steps.map(([id, name]) => ({ id, name, status: 'pending', detail: '' })),
  }
  currentJob = job
  setImmediate(() => void executeJob(job))
  return job
}

// 统一发送 JSON 响应；nosniff + no-store 防止缓存和 MIME 嗅探。
function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

// 读取并解析请求体 JSON。限制 4KB——这些接口的合法请求体只有一个
// confirm 字符串，超限即拒绝（413），防止大请求体攻击。
async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) {
      const error = new Error('请求内容过大')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    const error = new Error('JSON 格式无效')
    error.statusCode = 400
    throw error
  }
}

// -----------------------------------------------------------------------------
// 写操作（POST 启停接口）的前置安全校验：
//   1. 必须是 application/json——纯表单/简单请求直接拒绝，抬高 CSRF 门槛；
//   2. 若浏览器带了 Origin 头，其 host 必须与请求 Host 一致，
//      即拒绝其他站点页面发起的跨来源系统操作（CSRF 防护）。
// -----------------------------------------------------------------------------
function checkWriteRequest(request) {
  const contentType = String(request.headers['content-type'] || '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('写操作要求 application/json')
    error.statusCode = 415
    throw error
  }
  const origin = request.headers.origin
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = 'invalid'
    }
    if (originHost !== request.headers.host) {
      const error = new Error('拒绝跨来源系统操作')
      error.statusCode = 403
      throw error
    }
  }
}

// 静态文件的 Content-Type 映射表
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.urdf': 'application/xml; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

// -----------------------------------------------------------------------------
// 静态文件服务（前端页面）。
// 要点：
//   - 只允许 GET/HEAD；
//   - 路径解析后强制校验仍在 distRoot 之内，防止 ../ 目录穿越读取任意文件；
//   - 目录请求落到其 index.html；
//   - 无扩展名且文件不存在时回退到 dist/index.html（SPA history 路由支持）；
//   - index.html 不缓存，其余静态资源缓存 1 小时。
// -----------------------------------------------------------------------------
async function serveStatic(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(response, 400, { error: 'Bad Request' })
    return
  }
  let filePath = path.resolve(distRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
  // 目录穿越防护：解析结果必须等于 distRoot 或位于其子目录内
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html')
  } catch {
    // 文件不存在且无扩展名：回退到 SPA 入口
    if (!path.extname(filePath)) filePath = path.join(distRoot, 'index.html')
  }
  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    sendJson(response, 404, { error: 'Not Found' })
  }
}

// -----------------------------------------------------------------------------
// HTTP 路由
//   GET  /api/system/status        —— 查询启动器模式、三个服务状态、当前任务、服务器时间
//   POST /api/system/start         —— 启动机械臂软件系统（body: {"confirm": "START"}）
//   POST /api/system/shutdown      —— 关闭机械臂系统（body: {"confirm": "ARM_SHUTDOWN"}）
//   POST /api/system/host-shutdown —— 关闭 ROS 主机（body: {"confirm": "HOST_SHUTDOWN"}）
//   其余 /api/* 一律 404；非 API 路径走静态文件服务。
// -----------------------------------------------------------------------------
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  try {
    // 状态查询接口：前端系统电源面板靠轮询它刷新服务状态与任务进度
    if (url.pathname === '/api/system/status' && request.method === 'GET') {
      sendJson(response, 200, {
        launcherMode: adapter.mode,
        services: await adapter.getServices(),
        job: currentJob,
        serverTime: new Date().toISOString(),
      })
      return
    }
    // 三个写操作路径 → 操作名的映射
    const operationByPath = {
      '/api/system/start': 'start',
      '/api/system/shutdown': 'shutdown',
      '/api/system/host-shutdown': 'host',
    }
    const operation = operationByPath[url.pathname]
    if (operation && request.method === 'POST') {
      checkWriteRequest(request)
      const body = await readJson(request)
      // 必须携带与该操作匹配的确认字符串，否则视为误触/伪造请求
      if (body.confirm !== OPERATIONS[operation].confirmation) {
        sendJson(response, 400, { error: '缺少与操作匹配的确认字段' })
        return
      }
      const job = startJob(operation)
      // 202 Accepted：任务已受理，正在异步执行
      sendJson(response, 202, { jobId: job.id, job })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Not Found' })
      return
    }
    await serveStatic(request, response, url.pathname)
  } catch (error) {
    // 统一错误出口：业务错误自带 statusCode，未预期的错误按 500 处理
    sendJson(response, error.statusCode || 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, host, () => {
  console.log(`reBot launcher listening on http://${host}:${port} (${adapter.mode} mode)`)
})

// 优雅退出：收到 SIGINT/SIGTERM 时先停止接收新连接再退出；
// 5 秒兜底强制退出，unref() 使该定时器本身不阻止进程退出。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  })
}
