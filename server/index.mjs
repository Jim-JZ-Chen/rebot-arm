import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockAdapter, createSystemdAdapter } from './adapters.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(root, 'dist')
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3000)
const adapter = process.env.REBOT_LAUNCHER_MODE === 'systemd' ? createSystemdAdapter() : createMockAdapter()

const OPERATIONS = {
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

let currentJob = null

async function executeJob(job) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  for (const step of job.steps) {
    step.status = 'running'
    step.startedAt = new Date().toISOString()
    job.updatedAt = step.startedAt
    try {
      const result = await adapter.runStep(step.id)
      step.status = result.skipped ? 'skipped' : 'success'
      step.detail = result.detail
      step.finishedAt = new Date().toISOString()
      job.updatedAt = step.finishedAt
    } catch (error) {
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
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html')
  } catch {
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  try {
    if (url.pathname === '/api/system/status' && request.method === 'GET') {
      sendJson(response, 200, {
        launcherMode: adapter.mode,
        services: await adapter.getServices(),
        job: currentJob,
        serverTime: new Date().toISOString(),
      })
      return
    }
    const operationByPath = {
      '/api/system/start': 'start',
      '/api/system/shutdown': 'shutdown',
      '/api/system/host-shutdown': 'host',
    }
    const operation = operationByPath[url.pathname]
    if (operation && request.method === 'POST') {
      checkWriteRequest(request)
      const body = await readJson(request)
      if (body.confirm !== OPERATIONS[operation].confirmation) {
        sendJson(response, 400, { error: '缺少与操作匹配的确认字段' })
        return
      }
      const job = startJob(operation)
      sendJson(response, 202, { jobId: job.id, job })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Not Found' })
      return
    }
    await serveStatic(request, response, url.pathname)
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, host, () => {
  console.log(`reBot launcher listening on http://${host}:${port} (${adapter.mode} mode)`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  })
}
