/**
 * dsh-agent-selector — host half (v0.1.0)
 *
 * 智能体选择器：像模型选择器一样勾选委托目标，把当前对话的任务派给外部智能体执行，结果回对话。
 * 通道：
 *   - codex      : 本机 codex CLI（node 直调 codex.js exec -m <配置模型>，规避 .CMD 垫片与 config.toml 默认模型雷）
 *   - hy3        : WorkBuddy automation 桥（scripts/wb_bridge.py 直写 automations 表，实验验证见
 *                  wb-bridge-experiment/EXPERIMENT-REPORT.md；异步分钟级，消耗 WorkBuddy 订阅=hy3 活动价）
 *   - claude-code: 挂起（壳后端=DeepSeek，新版 2.1.x 目录硬校验拒 deepseek-v4-pro；面板如实标黄灯）
 * 面板：设置 →「🤖 智能体选择器」（client half，/__agent-selector/api）
 */
export const name = 'dsh-agent-selector'
export const inject = ['tools', 'subprocess', 'webServer']

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const CFG_DIR = path.join(HOME, '.dsh', 'agent-selector')
const CFG_FILE = path.join(CFG_DIR, 'config.json')
const BRIDGE_JS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'wb_bridge.py')
const PY_CANDIDATES = [
  path.join(HOME, '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe'),
  'python',
]
const CODEX_JS_CANDIDATES = [
  path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'codex', 'bin', 'codex.js'),
]
const CLAUDE_EXE_CANDIDATES = [
  path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
]
const WB_DB = path.join(HOME, '.workbuddy', 'workbuddy.db')
const WB_MODELS_JSON = path.join(HOME, '.workbuddy', 'models.json')
const MAX_OUTPUT_CHARS = 20000
const DEFAULT_CONFIG = { defaultTarget: 'codex', codexModel: 'gpt-5.6-terra', hy3Model: 'hy3', wbCustomModel: '', claudeModel: 'deepseek-v4-pro', defaultCwd: os.homedir() }
// WorkBuddy 内置 modelId 清单：动态聚合（bridge models 子命令：sessions.model ∪ automations.model_id，
// 对照桌面端 /model 面板的显示名映射在 wb_bridge.py 的 WB_BUILTIN_LABELS——桌面端上下架此处自动跟随）
const WB_FALLBACK_MODELS = [
  { id: 'hy3', label: 'Hy3（限时免费）' },
  { id: 'hy4-preview', label: 'Hy4 preview（限时免费）' },
  { id: 'glm-5.3', label: 'GLM-5.3（0.79x）' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash（0.06x）' },
  { id: 'glm-5.2', label: 'GLM-5.2（0.79x 夜间折扣）' },
]
const CODEX_MODELS = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-reserve'].map(m => ({ id: m, label: m }))
const CLAUDE_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash'].map(m => ({ id: m, label: m }))

function readWbCustomModels() {
  try {
    const arr = JSON.parse(fs.readFileSync(WB_MODELS_JSON, 'utf8'))
    return (Array.isArray(arr) ? arr : []).map(m => ({ id: m.id || '', name: m.name || m.id || '', vendor: m.vendor || '' })).filter(m => m.id)
  } catch { return [] }
}

function clip(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(0, Math.floor(max * 0.7)) + '\n\n…[输出过长，已省略中间 ' + (text.length - max) + ' 字符]…\n' + text.slice(-Math.floor(max * 0.25))
}

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } } catch { return { ...DEFAULT_CONFIG } }
}
function saveConfig(cfg) {
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)) } catch { /* 尽力持久化 */ }
  return cfg
}

function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p } catch { /* 忽略 */ } }
  return null
}

function probeAgents() {
  const codexJs = firstExisting(CODEX_JS_CANDIDATES)
  const claudeExe = firstExisting(CLAUDE_EXE_CANDIDATES)
  const py = firstExisting(PY_CANDIDATES)
  const cfg = loadConfig()
  const claudeBackend = process.env.ANTHROPIC_MODEL || ''
  const claudeBaseUrl = process.env.ANTHROPIC_BASE_URL || ''
  return {
    ok: true,
    result: {
      codex: { available: !!codexJs, codexJs, model: cfg.codexModel || '', models: CODEX_MODELS },
      hy3: { available: fs.existsSync(WB_DB), db: WB_DB, note: '活动价通道 · 异步分钟级 · 模型清单动态聚合桌面端', models: WB_FALLBACK_MODELS, model: cfg.hy3Model || 'hy3' },
      wbmodel: { available: fs.existsSync(WB_MODELS_JSON), file: WB_MODELS_JSON, note: 'WorkBuddy 自定义模型直连（你的 API key · 同步秒级）', models: readWbCustomModels(), model: cfg.wbCustomModel || '' },
      'claude-code': {
        available: !!claudeExe,
        suspended: false,
        claudeExe: claudeExe,
        backend: claudeBackend,
        baseUrl: claudeBaseUrl,
        models: CLAUDE_MODELS,
        model: cfg.claudeModel || 'deepseek-v4-pro',
        note: 'DeepSeek 壳（ANTHROPIC_BASE_URL→api.deepseek.com）：槽位 pin + 双 key 注入后实测通过；stderr 的 unrecognized_model 为诊断线不致命',
      },
      python: py,
      config: cfg,
    },
  }
}

function resolveTarget(ctx, target) {
  const cfg = loadConfig()
  let t = target || 'auto'
  if (t === 'auto') t = cfg.defaultTarget || 'codex'
  if (t === 'claude-code') {
    if (!firstExisting(CLAUDE_EXE_CANDIDATES)) return { error: 'claude 未安装（未找到 claude.exe）' }
    return { target: t, cfg }
  }
  if (t !== 'codex' && t !== 'hy3' && t !== 'wbmodel') return { error: '未知 target: ' + t }
  return { target: t, cfg }
}

function spawnChild(ctx, argv, cwd, extraEnv) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) throw new Error('宿主 subprocess 服务不可用')
  const opts = { argv, cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 15000 }
  if (extraEnv) opts.env = { ...process.env, ...extraEnv }
  return subprocess.spawn(opts)
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout?.on('data', (c) => { if (out.length < MAX_OUTPUT_CHARS * 2) out += c })
    child.stderr?.on('data', (c) => { if (err.length < 8000) err += c })
    const fail = (e) => reject(e instanceof Error ? e : new Error(String(e)))
    child.done.then((outcome) => resolve({ code: outcome?.exitCode, out, err })).catch(fail)
  })
}

async function runCodex(ctx, task, cwd, codexModel, signal) {
  const codexJs = firstExisting(CODEX_JS_CANDIDATES)
  if (!codexJs) throw new Error('codex 未安装（未找到 codex.js）')
  const argv = [process.execPath, codexJs, 'exec', '--skip-git-repo-check', '--ephemeral', '-m', codexModel, task]
  const child = spawnChild(ctx, argv, cwd)
  const kill = () => { try { child.terminate?.() } catch { /* 忽略 */ } }
  const onAbort = () => kill()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  try {
    try { child.stdin?.end() } catch { /* 忽略 */ }
    const t0 = Date.now()
    const res = await Promise.race([
      collect(child),
      new Promise((_, rej) => { timer = setTimeout(() => { kill(); rej(new Error('TIMEOUT')) }, 600000) }),
    ])
    if (res.code !== 0) throw new Error('codex 退出码 ' + res.code + '：' + (res.err || res.out).trim().slice(0, 400))
    // 执行凭证：exec 输出里的 session id 只有真实执行才存在
    const sid = (res.out.match(/session id:\s*([0-9a-f-]{8,})/i) || [])[1] || ''
    const secs = Math.round((Date.now() - t0) / 1000)
    return clip('[codex · ' + codexModel + ' · ' + secs + 's' + (sid ? ' · session ' + sid.slice(0, 8) : '') + ']\n\n' + res.out.trim())
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

async function runHy3(ctx, task, cwd, timeoutMs, signal, modelId) {
  const py = firstExisting(PY_CANDIDATES)
  if (!py) throw new Error('未找到 python（wb_bridge.py 需要）')
  if (!fs.existsSync(WB_DB)) throw new Error('未找到 WorkBuddy 数据库（' + WB_DB + '）')
  fs.mkdirSync(cwd, { recursive: true })
  // IO 全文件化：DSH spawn 管道在 Windows 按系统编码（GBK）处理，中文必坏——
  // 管道只传路径，数据走临时文件（UTF-8），与 wb_bridge.py --in/--out 成对。
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agssel-'))
  const inF = path.join(ioDir, 'in.json')
  const outF = path.join(ioDir, 'out.json')
  fs.writeFileSync(inF, JSON.stringify({ model: modelId || 'hy3', prompt: task, cwd, timeoutMs: timeoutMs || 600000 }), 'utf8')
  const child = spawnChild(ctx, [py, BRIDGE_JS, 'enqueue', '--in', inF, '--out', outF], cwd)
  const kill = () => { try { child.terminate?.() } catch { /* 忽略 */ } }
  const onAbort = () => kill()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  try {
    try { child.stdin?.end() } catch { /* 忽略 */ }
    await Promise.race([
      collect(child),
      new Promise((_, rej) => { timer = setTimeout(() => { kill(); rej(new Error('TIMEOUT')) }, (timeoutMs || 600000) + 120000) }),
    ])
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(outF, 'utf8')) } catch { parsed = null }
    if (!parsed) throw new Error('hy3 桥未产出结果文件（桥进程可能异常退出）')
    if (!parsed.ok) throw new Error('hy3 桥失败：' + (parsed.reason || 'unknown'))
    return clip('[hy3 · WorkBuddy 活动价通道 · 模型 ' + (modelId || 'hy3') + ' · 耗时 ' + Math.round((parsed.durationMs || 0) / 1000) + 's]\n\n' + (parsed.text || ''))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    try { fs.rmSync(ioDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

async function runWbModel(ctx, task, cwd, modelId, signal) {
  const py = firstExisting(PY_CANDIDATES)
  if (!py) throw new Error('未找到 python（wb_bridge.py 需要）')
  if (!fs.existsSync(WB_MODELS_JSON)) throw new Error('未找到 models.json（' + WB_MODELS_JSON + '）')
  if (!modelId) throw new Error('未选择自定义模型（面板/下拉里先选一个）')
  fs.mkdirSync(cwd, { recursive: true })
  // 文件化 IO，同 runHy3
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agssel-'))
  const inF = path.join(ioDir, 'in.json')
  const outF = path.join(ioDir, 'out.json')
  fs.writeFileSync(inF, JSON.stringify({ model: modelId, prompt: task }), 'utf8')
  const child = spawnChild(ctx, [py, BRIDGE_JS, 'call', '--in', inF, '--out', outF], cwd)
  const kill = () => { try { child.terminate?.() } catch { /* 忽略 */ } }
  const onAbort = () => kill()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  try {
    try { child.stdin?.end() } catch { /* 忽略 */ }
    await Promise.race([
      collect(child),
      new Promise((_, rej) => { timer = setTimeout(() => { kill(); rej(new Error('TIMEOUT')) }, 660000) }),
    ])
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(outF, 'utf8')) } catch { parsed = null }
    if (!parsed) throw new Error('直连通道未产出结果文件（桥进程可能异常退出）')
    if (!parsed.ok) throw new Error('直连失败：' + (parsed.reason || 'unknown'))
    return clip('[WorkBuddy 自定义模型 · ' + (parsed.model_used || modelId) + ' · 耗时 ' + Math.round((parsed.durationMs || 0) / 1000) + 's]\n\n' + (parsed.text || ''))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    try { fs.rmSync(ioDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

async function runClaude(ctx, task, cwd, claudeModel, signal) {
  const claudeExe = firstExisting(CLAUDE_EXE_CANDIDATES)
  if (!claudeExe) throw new Error('claude 未安装（未找到 claude.exe）')
  const tok = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (!tok) throw new Error('未找到 ANTHROPIC_AUTH_TOKEN（User 环境变量）——claude 壳的 DeepSeek 凭据缺失')
  // 新版 2.1.x 目录硬校验的官方解法：sonnet/haiku 槽位 pin 到 DeepSeek 模型 +
  // 双 key（pin 路径不读 AUTH_TOKEN，需同时给 API_KEY）+ 窗口豁免。
  // stderr 的 unrecognized_model 行是诊断线，不致命（官方文档：every provider 都会写）。
  const extraEnv = {
    ANTHROPIC_AUTH_TOKEN: tok,
    ANTHROPIC_API_KEY: tok,
    ANTHROPIC_MODEL: claudeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
  }
  const child = spawnChild(ctx, [claudeExe, '-p', task, '--output-format', 'text'], cwd, extraEnv)
  const kill = () => { try { child.terminate?.() } catch { /* 忽略 */ } }
  const onAbort = () => kill()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  let timer
  try {
    try { child.stdin?.end() } catch { /* 忽略 */ }
    const t0 = Date.now()
    const res = await Promise.race([
      collect(child),
      new Promise((_, rej) => { timer = setTimeout(() => { kill(); rej(new Error('TIMEOUT')) }, 600000) }),
    ])
    const text = res.out.trim()
    if (res.code !== 0 && !text) throw new Error('claude 退出码 ' + res.code + '：' + (res.err || res.out).trim().slice(0, 400))
    const secs = Math.round((Date.now() - t0) / 1000)
    return clip('[claude-code · ' + claudeModel + ' · DeepSeek 壳 · ' + secs + 's]\n\n' + text)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

async function dispatchAgent(ctx, args, exec) {
  const task = typeof args?.task === 'string' ? args.task.trim() : ''
  if (!task) throw new Error('agent_dispatch 需要非空 task（对方看不到本会话上下文，请给自包含任务描述）')
  const r = resolveTarget(ctx, args?.target)
  if (r.error) throw new Error(r.error)
  const cwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ||
    (typeof exec?.agent?.session?.header?.cwd === 'string' && exec.agent.session.header.cwd.trim()) ||
    process.cwd()
  const signal = exec?.signal
  if (r.target === 'codex') return runCodex(ctx, task, cwd, r.cfg.codexModel || 'gpt-5.6-terra', signal)
  if (r.target === 'hy3') return runHy3(ctx, task, cwd, 600000, signal, r.cfg.hy3Model || 'hy3')
  if (r.target === 'wbmodel') return runWbModel(ctx, task, cwd, r.cfg.wbCustomModel || '', signal)
  if (r.target === 'claude-code') return runClaude(ctx, task, cwd, r.cfg.claudeModel || 'deepseek-v4-pro', signal)
  throw new Error('unreachable target: ' + r.target)
}

export function apply(ctx) {
  const cfg0 = loadConfig()
  console.log('[agent-selector] loaded, defaultTarget=' + cfg0.defaultTarget + ' codexModel=' + cfg0.codexModel)

  // ---- 模型工具：agent_dispatch ----
  try {
    ctx.tools.register({
      name: 'agent_dispatch',
      description:
        '把一件自包含任务派给外部智能体执行并把结果带回对话。可用 target：' +
        'codex（ChatGPT 原生额度，分钟内）、hy3（WorkBuddy 内置模型走活动价订阅，异步 1~8 分钟）、' +
        'wbmodel（WorkBuddy 自定义模型如 MiniMax-M3/kimi-k3/ox-alpha/qwen3.8 走用户自己的 API key，同步秒~分钟）、' +
        'claude-code（claude 壳→DeepSeek，槽位 pin 已修，分钟内）、' +
        "auto（用下拉/面板勾选的目标+模型组合）。对方看不到本会话上下文，task 必须自包含。当前默认：" + (cfg0.defaultTarget || 'codex') +
        '。⚠️ 反冒充条款：凡用户要求「用 codex/hy3/wbmodel/claude/外部智能体/某模型干」的任务，必须实际调用本工具取得带出处前缀的结果；' +
        '严禁不调用本工具而自行作答并冒充外部智能体的结论；工具失败时如实报告失败，不得用自己的回答顶替。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['auto', 'codex', 'hy3', 'wbmodel', 'claude-code'], description: '委托目标；auto=下拉/面板勾选的目标+模型组合' },
          task: { type: 'string', description: '完整的自包含任务描述（对方看不到本会话上下文）' },
          cwd: { type: 'string', description: '可选：执行工作目录（文件类任务建议给出）' },
        },
        required: ['task'],
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      timeoutMs: 15 * 60 * 1000,
      isConcurrencySafe: () => true,
      presentCall: (a) => ({
        card: 'generic',
        title: '智能体委派 → ' + (a?.target === 'auto' ? (loadConfig().defaultTarget || 'codex') : (a?.target || 'auto')),
        kind: 'execute',
        rawInput: a,
      }),
      async execute(args, exec) {
        return dispatchAgent(ctx, args, exec)
      },
    })
  } catch (e) {
    console.error('[agent-selector] tool registration skipped: ' + e)
  }

  // ---- RPC：/__agent-selector/api（POST {method,args}，loopback 围栏）----
  const handler = async (req, res) => {
    const addr = req.socket?.remoteAddress || ''
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    const done = (obj) => { try { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)) } catch { /* 忽略 */ } }
    if (!loopback) return done({ ok: false, error: 'loopback only' })
    if (req.method !== 'POST') return done({ ok: false, error: 'POST only' })
    let body = ''
    req.on('data', (c) => { if (body.length < 1e6) body += c })
    req.on('end', async () => {
      let method = '', args = {}
      try { const j = JSON.parse(body || '{}'); method = j.method; args = j.args || {} } catch { return done({ ok: false, error: 'bad json' }) }
      try {
        if (method === 'agents.list') {
          const probe = probeAgents()
          // 异步增强：hy3 内置模型清单动态聚合（sessions.model ∪ automations.model_id，桌面端同款）
          try {
            const py = firstExisting(PY_CANDIDATES)
            if (py) {
              const child = spawnChild(ctx, [py, BRIDGE_JS, 'models'], process.cwd())
              const r = await Promise.race([collect(child), new Promise((_, rej) => setTimeout(() => rej(new Error('models timeout')), 20000))])
              const parsed = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop())
              if (parsed && parsed.ok && Array.isArray(parsed.models) && parsed.models.length) probe.result.hy3.models = parsed.models
            }
          } catch { /* fallback 清单已在 */ }
          return done(probe)
        }
        if (method === 'config.get') return done({ ok: true, result: loadConfig() })
        if (method === 'config.set') return done({ ok: true, result: saveConfig({ ...loadConfig(), ...(args.config || {}) }) })
        if (method === 'hy3.probe') {
          const py = firstExisting(PY_CANDIDATES)
          if (!py) return done({ ok: false, error: 'python not found' })
          const child = spawnChild(ctx, [py, BRIDGE_JS, 'probe'], process.cwd())
          const r = await Promise.race([collect(child), new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 30000))])
          let parsed
          try { parsed = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop()) } catch { parsed = { ok: false, reason: 'unparseable: ' + r.out.slice(0, 120) } }
          return done({ ok: true, result: parsed })
        }
        if (method === 'dispatch.test') {
          const testCwd = (typeof args.cwd === 'string' && args.cwd.trim()) || loadConfig().defaultCwd || process.cwd()
          const text = await dispatchAgent(ctx, { target: args.target, task: args.task || '这是一次链路验证。请只输出一行：AGENT-SELECTOR-OK', cwd: testCwd }, { agent: { session: { header: { cwd: testCwd } } } })
          return done({ ok: true, result: text })
        }
        return done({ ok: false, error: 'unknown method: ' + method })
      } catch (e) {
        return done({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 600) })
      }
    })
  }
  try {
    const ws = ctx.get('webServer') || ctx.webServer
    if (!ws) { console.error('[agent-selector] webServer unavailable'); return }
    ctx.effect(() => ws.register({ kind: 'prefix', path: '/__agent-selector', handler }), (e) => console.error('[agent-selector] register error: ' + e))
  } catch (e) {
    console.error('[agent-selector] route registration failed: ' + e)
  }
}
