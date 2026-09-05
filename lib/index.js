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
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
// v0.2.0: ACP 原生续聊通道（阶段 2 核心）——dmode>=2 时优先走，失败回退 automation 桥
import { acpDispatch, acpListModels } from './acp.js'

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
const DEFAULT_CONFIG = { defaultTarget: 'codex', codexModel: 'gpt-5.6-terra', hy3Model: 'hy3', wbCustomModel: '', claudeModel: 'deepseek-v4-pro', defaultCwd: os.homedir(), delegateMode: 0 }
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

function loadBaseConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } } catch { return { ...DEFAULT_CONFIG } }
}
// v0.1.6: per-session state — defaults + sessions[sessionId] override (A 项目选 hy3 不影响 B 项目)
function loadConfig(sessionId) {
  const base = loadBaseConfig()
  if (!sessionId || !base.sessions || !base.sessions[sessionId]) return base
  const s = base.sessions[sessionId]
  const merged = { ...base }
  for (const k of Object.keys(s)) { if (k !== 'sessions') merged[k] = s[k] }
  return merged
}
function saveConfig(sessionId, patch) {
  try {
    const base = loadBaseConfig()
    if (sessionId) {
      base.sessions = base.sessions || {}
      base.sessions[sessionId] = { ...(base.sessions[sessionId] || {}), ...patch }
      // 会话状态上限防膨胀：保留最近 50 个（按对象键序近似 LRU，超出删最旧）
      const keys = Object.keys(base.sessions)
      if (keys.length > 50) { for (const k of keys.slice(0, keys.length - 50)) delete base.sessions[k] }
    } else {
      Object.assign(base, patch)
    }
    fs.mkdirSync(CFG_DIR, { recursive: true })
    fs.writeFileSync(CFG_FILE, JSON.stringify(base, null, 2))
  } catch { /* 尽力持久化 */ }
  return loadConfig(sessionId)
}

function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p } catch { /* 忽略 */ } }
  return null
}

function probeAgents(sessionId) {
  const codexJs = firstExisting(CODEX_JS_CANDIDATES)
  const claudeExe = firstExisting(CLAUDE_EXE_CANDIDATES)
  const py = firstExisting(PY_CANDIDATES)
  const cfg = loadConfig(sessionId)
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

function resolveTarget(ctx, target, sessionId) {
  const cfg = loadConfig(sessionId)
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

// ---- v0.2.0: session memory — 3 sections (permanent/stream/suggestions), trim only on stream ----
const MEM_DIR = path.join(CFG_DIR, 'session-memory')
const STREAM_KEEP_ROUNDS = 6
const STREAM_MAX_CHARS = 6000
function memFileFor(sessionId) { return path.join(MEM_DIR, (sessionId || 'global') + '.md') }
function readMemory(sessionId) {
  try { const t = fs.readFileSync(memFileFor(sessionId), 'utf8').trim(); return t || '' } catch { return '' }
}
function readMemorySections(sessionId) {
  const raw = readMemory(sessionId)
  const get = (tag) => {
    const m = raw.match(new RegExp('# ' + tag + '\n([\\s\\S]*?)(?=\n# |$)'))
    return m ? m[1].trim() : ''
  }
  return { permanent: get('永久区'), suggestions: get('待确认建议'), rest: raw }
}
function appendMemory(sessionId, userTask, agentResult, needsClarification) {
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
    const prev = readMemorySections(sessionId)
    const roundNo = ((prev.rest.match(/## 轮次 /g) || []).length) + 1
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    const entry = '\n\n## 轮次 ' + roundNo + '（' + stamp + '）\n' +
      (needsClarification ? '- **反问（待答复）**：' + String(agentResult).slice(0, 300).replace(/\s+/g, ' ') : '- **用户**：' + String(userTask).slice(0, 200).replace(/\s+/g, ' ') + '\n- **结论**：' + String(agentResult).slice(0, 600).replace(/\s+/g, ' '))
    let stream = prev.rest
      .replace(new RegExp('^# 会话记忆[^\\n]*\\n?'), '')
      .replace(/\n## 智能体记忆更新建议[\s\S]*$/, '')
      .trim()
    stream = stream + entry
    // v0.2.0: trim applies ONLY to the stream section
    const parts = stream.split('\n## 轮次 ')
    if (parts.length - 1 > STREAM_KEEP_ROUNDS) {
      stream = parts[0] + '\n## 轮次 ' + parts.slice(parts.length - STREAM_KEEP_ROUNDS).join('\n## 轮次 ')
    }
    if (stream.length > STREAM_MAX_CHARS) { stream = '…（更早内容已截断）\n' + stream.slice(-STREAM_MAX_CHARS) }
    let next = '# 会话记忆（结构化 · 由 dsh-agent-selector 维护）\n'
    if (prev.permanent) next += '# 永久区\n' + prev.permanent + '\n\n'
    next += '# 流水区\n## 轮次 ' + stream.split('\n## 轮次 ').slice(1).join('\n## 轮次 ')
    if (prev.suggestions) next += '\n\n# 待确认建议\n' + prev.suggestions
    fs.writeFileSync(memFileFor(sessionId), next, 'utf8')
  } catch { /* 记忆失败不阻断委派 */ }
}
function mergeSuggestions(sessionId, sugText) {
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
    const prev = readMemorySections(sessionId)
    const stamped = sugText.trim().split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => '- [' + new Date().toLocaleDateString('zh-CN') + '] ' + l.replace(/^-\s*/, '')).join('\n')
    // v0.2.0: dedup by normalized line, cap 12 entries
    const existing = prev.suggestions.split('\n').map(x => x.replace(/^- \[[^\]]+\] /, '- ').trim())
    const fresh = stamped.split('\n').filter(l => { const norm = l.replace(/^- \[[^\]]+\] /, '- ').trim(); return !existing.some(x2 => x2 === norm) })
    if (!fresh.length) return
    let sug = prev.suggestions ? prev.suggestions + '\n' + fresh.join('\n') : fresh.join('\n')
    const lines = sug.split('\n')
    if (lines.length > 12) sug = lines.slice(lines.length - 12).join('\n')
    let next = '# 会话记忆（结构化 · 由 dsh-agent-selector 维护）\n'
    if (prev.permanent) next += '# 永久区\n' + prev.permanent + '\n\n'
    if (prev.rest.trim()) next += '# 流水区\n' + prev.rest.trim() + '\n\n'
    next += '# 待确认建议\n' + sug
    fs.writeFileSync(memFileFor(sessionId), next, 'utf8')
  } catch { /* 尽力 */ }
}
// v0.1.8: tiered permission note (0=OFF/1=readonly/2=workspace-write/3=full)
function permNote(dmode, cwd) {
  if (dmode === 1) return '【权限约束 · 仅查看】本次委派为只读模式：禁止修改、创建、删除任何项目文件（result.md 除外）；只做检索、阅读与分析，产出写入结果。\n'
  if (dmode === 2) return '【权限说明 · 工作区内修改】本次委派允许在当前工作区（' + cwd + '）内读取和修改文件与代码以完成任务；工作区之外的文件一律只读。优先最小必要修改。\n'
  if (dmode >= 3) return '【权限说明 · 完全权限】本次委派具有等同 DSH 完全权限，可读写工作区内外的文件。请谨慎操作、最小必要修改，重要文件改动前先说明。\n'
  return ''
}

// v0.1.9: SSOT warmup — point the agent at workspace memory files (AGENTS.md / LESSONS_LEARNED.md)
// v0.2.0: 抽成函数，ACP 通道与 automation 桥共用同一份 SSOT 指针
function ssotNote(cwd) {
  try {
    const ssotFiles = ['AGENTS.md', 'LESSONS_LEARNED.md'].filter(fn => { try { return fs.existsSync(path.join(cwd, fn)) } catch { return false } })
    if (!ssotFiles.length) return ''
    return '【工作区 SSOT · 动手前必读】本项目工作区根目录存在记忆文件：' + ssotFiles.join('、') +
      '（AGENTS.md=架构/部署/约束/坑 的 SSOT；LESSONS_LEARNED.md=踩坑与修复记录）。' +
      '修改代码或执行有影响的操作前，先用你的文件工具读取它们的相关章节，确认不违背已记录的约束与已知坑。\n\n'
  } catch { return '' }
}

const MEMORY_BRIEF_HEADER = '【会话记忆 · 之前对话的结构化状态（由系统自动携带，请视为你已知悉的上下文）】\n'

async function runHy3(ctx, task, cwd, timeoutMs, signal, modelId, memoryFile, dmode, effort) {
  const py = firstExisting(PY_CANDIDATES)
  if (!py) throw new Error('未找到 python（wb_bridge.py 需要）')
  if (!fs.existsSync(WB_DB)) throw new Error('未找到 WorkBuddy 数据库（' + WB_DB + '）')
  fs.mkdirSync(cwd, { recursive: true })
  // IO 全文件化：DSH spawn 管道在 Windows 按系统编码（GBK）处理，中文必坏——
  // 管道只传路径，数据走临时文件（UTF-8），与 wb_bridge.py --in/--out 成对。
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agssel-'))
  const inF = path.join(ioDir, 'in.json')
  const outF = path.join(ioDir, 'out.json')
  const perm = permNote(dmode | 0, cwd)
  const ssot = ssotNote(cwd)
  const memText = memoryFile ? readMemory(path.basename(memoryFile, '.md')) : ''
  const briefTask = (perm ? perm + '\n' : '') + ssot +
    (memoryFile
      ? ((memText ? (MEMORY_BRIEF_HEADER + memText + '\n\n') : '') +
         '【本轮任务】' + task + '\n\n【本轮输出要求】完成后请输出：1) 针对本轮任务的结果；2) 若与记忆中的未决问题相关，给出衔接说明。')
      : task)
  // v0.2.1: 推理档位透传 automation 桥——effort="off" → thinking=0（关思考），否则 1（开思考）
  const thinking = String(effort || '') === 'off' ? 0 : 1
  fs.writeFileSync(inF, JSON.stringify({ model: modelId || 'hy3', prompt: briefTask, cwd, timeoutMs: timeoutMs || 600000, thinking }), 'utf8')
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
    if (!parsed.ok && parsed.reason === 'running' && parsed.aid) {
      // v0.1.9d: skeleton still present = bridge died mid-run — cancel the ghost automation row
      try { spawnChild(ctx, [py, BRIDGE_JS, 'cancel', '--id', parsed.aid], cwd) } catch { /* best effort */ }
      throw new Error('hy3 桥中途退出（已取消残留任务 ' + parsed.aid + '）')
    }
    if (!parsed.ok) throw new Error('hy3 桥失败：' + (parsed.reason || 'unknown'))
    if (parsed.needsClarification) {
      // v0.1.9 反问通道：任务缺关键信息，智能体主动反问——原样抛回用户，不入记忆流水
      return clip('【智能体反问 · 任务需要澄清】\n\n' + (parsed.text || '') +
        '\n\n（请在对话中直接回答上述问题，下次委派时会随任务一并送达）')
    }
    if (memoryFile) {
      appendMemory(path.basename(memoryFile, '.md'), task, (parsed.text || ''), !!parsed.needsClarification)
      // v0.2.0 bidirectional memory: dedup + stamp + cap via mergeSuggestions
      try {
        const sug = (parsed.text || '').split('## 记忆更新建议')[1]
        if (sug && sug.trim()) mergeSuggestions(path.basename(memoryFile, '.md'), sug)
      } catch { /* 记忆建议解析失败不阻断 */ }
    }
    return clip('[hy3 · WorkBuddy 活动价通道 · 模型 ' + (modelId || 'hy3') + (String(effort || '') === 'off' ? ' · 🧠关' : ' · 🧠开') + ' · 耗时 ' + Math.round((parsed.durationMs || 0) / 1000) + 's]\n\n' + (parsed.text || ''))
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
  // v0.1.6: per-session target resolution — prefer explicit args.targetSessionId,
  // then the calling session's id from the tool exec context.
  const callSessionId = (typeof args?.targetSessionId === 'string' && args.targetSessionId) ||
    (exec?.agent?.session && (exec.agent.session.id || exec.agent.session.header?.id)) || ''
  const r = resolveTarget(ctx, args?.target, callSessionId)
  if (r.error) throw new Error(r.error)
  const cwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ||
    (typeof exec?.agent?.session?.header?.cwd === 'string' && exec.agent.session.header.cwd.trim()) ||
    process.cwd()
  const signal = exec?.signal
  if (r.target === 'codex') return runCodex(ctx, task, cwd, r.cfg.codexModel || 'gpt-5.6-terra', signal)
  if (r.target === 'hy3') {
    const memFile = callSessionId ? memFileFor(callSessionId) : ''
    const dmode = r.cfg.delegateMode | 0
    // 同步/异步共用的执行体。sig=undefined 表示后台解耦路径——exec.signal 会随工具
    // 立即返回而 abort，传入会误杀桥子进程，故后台路径不传 signal。
    const execHy3 = async (sig) => {
      // v0.2.0: ACP 原生续聊通道（dmode>=2 才启用——1=仅查看档位下 ACP 无执行层隔离，
      // 沿用 automation 桥的 prompt 级约束；ACP 失败一律回退，绝不吞掉任务）
      if (dmode >= 2) {
        const brief = (permNote(dmode, cwd) || '') + '\n' + ssotNote(cwd) +
          '【本轮任务】' + task +
          '\n\n【本轮输出要求】完成后请输出：1) 针对本轮任务的结果；2) 若与记忆中的未决问题相关，给出衔接说明。'
        try {
          const acp = await acpDispatch({
            task: brief,
            cwd,
            acpSessionId: (r.cfg.acpSessionId || ''),
            // 空上下文自检：回传上次记录的宿主指纹，指纹变了说明宿主重启过，旧会话必然失忆 → 强制新建
            knownHostToken: (r.cfg.acpHostToken || ''),
            poolKey: callSessionId || '', // 连接池键=DSH 会话 id：同一会话复用同一条 ACP 连接，多轮历史才在
            dmode,
            // v0.2.1: 推理档位透传 ACP 通道（config.effort，缺省 standard）
            effort: (r.cfg.effort || 'standard'),
            // v0.2.3: 模型透传 ACP 通道（configId="model"，实测可写；非法值会被跳过并标注）
            model: (r.cfg.hy3Model || ''),
            // 异步化后不再受工具/桥超时上限挤压，预算放宽到 15 分钟
            timeoutMs: 900000,
          })
          // 会话级持久化 acpSessionId + 宿主指纹 → 下一条消息走 session/load 续同一会话（原生多轮记忆）
          if (callSessionId && acp.acpSessionId) {
            saveConfig(callSessionId, { acpSessionId: acp.acpSessionId, acpHostToken: acp.hostToken || '' })
          }
          // 自检信号落到返回前缀，让"假续聊"在对话里可见，而不是静默出错
          let acpNote = acp.sessionMode
          if (acp.hostChanged) acpNote += ' · ⚠️宿主已重启，旧会话失效，已开新会话'
          else if (acp.sessionBlank === true && acp.reused) acpNote += ' · ⚠️上下文可能丢失'
          if (acp.sessionReused) acpNote += ' · ⚠️新会话非空白，上下文可能混入无关历史'
          // v0.2.1: 档位标注——设置成功显示实际值，失败显示语义值以暴露问题
          const acpEffort = r.cfg.effort || 'standard'
          acpNote += acp.effortApplied ? ' · 🧠' + (acp.effortValue || acpEffort) : ' · 🧠未设(' + acpEffort + ')'
          // v0.2.3: 模型标注——设置成功显示模型 id，未生效显示 🖥未设(id) 以暴露问题
          acpNote += acp.modelApplied ? ' · 🖥' + (acp.modelValue || '') : ' · 🖥未设(' + (r.cfg.hy3Model || 'hy3') + ')'
          return clip('[hy3 · ACP 原生续聊 · ' + acpNote + ' · 耗时 ' + Math.round((acp.durationMs || 0) / 1000) + 's]\n\n' + (acp.text || ''))
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).slice(0, 300)
          console.error('[agent-selector] ACP 通道失败，回退 automation 桥: ' + why)
          const bridged = await runHy3(ctx, task, cwd, 900000, sig, r.cfg.hy3Model || 'hy3', memFile, dmode, r.cfg.effort || 'standard')
          return clip('[ACP 失败已回退: ' + why + ']\n\n' + bridged)
        }
      }
      return runHy3(ctx, task, cwd, 900000, sig, r.cfg.hy3Model || 'hy3', memFile, dmode, r.cfg.effort || 'standard')
    }
    // fire-and-callback 异步化（根治同步阻塞等待超时：任务 4s~10+ 分钟超过工具/桥超时上限
    // 就成孤儿）：有会话可回注时工具立即返回受理确认，hy3 后台执行，完成后经 agent.followup
    // 注入主对话；无会话（dispatch.test 探针）保持同步返回真实结果。
    if (callSessionId) {
      // 解析 followup 目标 agent（与委派模式守卫同款解析链：agents.get → sessionController.resolveAgent）。
      // agent 在 dispatchAgent 作用域内解析后被 fireFollowup 闭包捕获，异步回调中使用有效。
      let agent = null
      try {
        const agents = ctx.get('agents')
        agent = (agents && agents.get) ? agents.get(callSessionId) : null
        if (!agent || typeof agent.followup !== 'function') {
          const sc = ctx.get('sessionController')
          if (sc && typeof sc.resolveAgent === 'function') agent = await sc.resolveAgent(callSessionId)
        }
      } catch (e) {
        console.error('[agent-selector] followup agent resolve failed: ' + String(e && e.message || e))
      }
      // 规范 UserMessage 注入（形态与守卫 followup 一致：id/role/content/source.plugin——
      // 纯字符串无 source 会崩 turn，见 LESSONS 2026-08-29）
      const fireFollowup = (text) => {
        try {
          if (!agent || typeof agent.followup !== 'function') {
            console.error('[agent-selector] result followup skipped: agent unavailable for ' + callSessionId)
            return
          }
          agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-selector' } })
        } catch (e) {
          console.error('[agent-selector] result followup failed: ' + String(e && e.message || e))
        }
      }
      const p = execHy3(undefined)
      p.then((text) => fireFollowup(text))
        .catch((e) => fireFollowup('[委派失败] ' + (e instanceof Error ? e.message : String(e))))
        .catch(() => {}) // 链尾兜底：绝不让后台 promise 成为 unhandled rejection
      const combo = 'hy3 · ' + (r.cfg.hy3Model || 'hy3')
      return clip('✅ 已受理——' + combo + ' 后台执行中（预计数秒至数分钟，视任务复杂度）。完成后结果将自动送达本对话，届时请转述给用户。')
    }
    // 同步路径（dispatch.test 探针 / 无会话）：保持同步返回真实结果
    return execHy3(signal)
  }
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
          targetSessionId: { type: 'string', description: '可选：会话 id（委派模式自动注入，一般无需手动传）' },
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
          const probe = probeAgents(typeof args.sessionId === 'string' ? args.sessionId : '')
          // v0.2.3 修复 2：hy3 模型清单**三级回退**，前一级失败才降下一级。
          //   ① ACP session/new 的 result.models.availableModels —— 宿主自己下发的当前在售
          //      全集（含显示名/计价），本机没用过的模型也能看见，权威度最高。
          //   ② bridge `models` 子命令 —— sessions.model ∪ automations.model_id 反推，
          //      只能看到本机实际用过的（新上架/没用过的看不见）。
          //   ③ 静态清单 WB_FALLBACK_MODELS —— 离线兜底，保证面板永远不空。
          // modelsSource 回给前端，便于肉眼分辨"权威清单"与"兜底清单"。
          try {
            const acpModels = await acpListModels({ timeoutMs: 30000 })
            probe.result.hy3.models = acpModels.map((m) => ({ id: m.modelId, label: m.name || m.modelId }))
            probe.result.hy3.modelsSource = 'acp'
          } catch (e1) {
            try {
              const py = firstExisting(PY_CANDIDATES)
              if (!py) throw new Error('python not found')
              const child = spawnChild(ctx, [py, BRIDGE_JS, 'models'], process.cwd())
              const r = await Promise.race([collect(child), new Promise((_, rej) => setTimeout(() => rej(new Error('models timeout')), 20000))])
              const parsed = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop())
              if (parsed && parsed.ok && Array.isArray(parsed.models) && parsed.models.length) {
                probe.result.hy3.models = parsed.models
                probe.result.hy3.modelsSource = 'bridge'
              }
            } catch (e2) { /* 静态清单已在 probe 里，不再处理 */ }
            probe.result.hy3.modelsSource = probe.result.hy3.modelsSource || 'static'
          }
          return done(probe)
        }
        if (method === 'mode.announce') {
          // 委派模式开关切换：向目标会话注入规范模式指令（复用 multi-role-debate 验证过的
          // agents.get(sessionId) + 规范 UserMessage followup 形态——字符串无 source 会崩 turn）
          // v0.1.7b: client sends numeric args.mode (0/1/2); old boolean args.on kept for compat
          const dmode = (typeof args.mode === 'number') ? args.mode : (args.on ? 1 : 0)
          const on = dmode > 0
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
          // v0.1.5c: client config.set can silently lose delegateMode (observed reset to false) —
          // write it here so file/memory/announcement stay consistent.
          const cfgAfterSet = saveConfig(sessionId, { delegateMode: dmode })
          if (cfgAfterSet.delegateMode !== dmode) {
            return done({ ok: false, error: 'delegateMode persist failed (file write issue)' })
          }
          const agents = ctx.get('agents')
          let agent = (agents && agents.get) ? agents.get(sessionId) : null
          if (!agent || typeof agent.followup !== 'function') {
            try {
              const sc = ctx.get('sessionController')
              if (sc && typeof sc.resolveAgent === 'function') agent = sc.resolveAgent(sessionId)
            } catch (e) { console.error('[agent-selector] announce resolveAgent fallback failed: ' + String(e && e.message || e)) }
          }
          if (!agent) return done({ ok: false, error: 'session agent not found (resolveAgent also failed): ' + sessionId })
          const combo = (loadConfig(sessionId).defaultTarget === 'hy3')
            ? 'hy3 · ' + (loadConfig(sessionId).hy3Model || 'hy3')
            : (loadConfig(sessionId).defaultTarget === 'wbmodel')
              ? 'wbmodel · ' + (loadConfig(sessionId).wbCustomModel || '未选')
              : (loadConfig(sessionId).defaultTarget === 'claude-code')
                ? 'claude-code · ' + (loadConfig(sessionId).claudeModel || 'deepseek-v4-pro')
                : 'codex · ' + (loadConfig(sessionId).codexModel || 'gpt-5.6-terra')
          const tierName = dmode === 1 ? '仅查看' : dmode === 2 ? '工作区内修改' : dmode >= 3 ? '完全权限' : 'OFF'
          const text = dmode === 1
            ? '【委派模式 · 仅查看】用户选择将消息委派给你（当前目标：' + combo + '，档位：仅查看）。此后用户发送的每条消息请一律通过 agent_dispatch 工具（target="auto"）委派执行：你负责打包 brief、调用工具、转述结果与出处头。权限约束：本次为只读委派，禁止修改项目文件。无豁免，禁止自己回答。'
            : dmode === 2
              ? '【委派模式 · 工作区内修改】用户选择将消息委派给你（当前目标：' + combo + '，档位：工作区内修改）。此后用户发送的每条消息请一律通过 agent_dispatch 工具（target="auto"）委派执行：你负责打包 brief、调用工具、转述结果。权限：允许修改当前工作区内的文件与代码，工作区外只读。无豁免，禁止自己回答。'
              : dmode >= 3
                ? '【委派模式 · 完全权限】用户选择将消息委派给你（当前目标：' + combo + '，档位：完全权限）。此后用户发送的每条消息请一律通过 agent_dispatch 工具（target="auto"）委派执行。权限等同 DSH 完全权限：谨慎操作、最小必要修改。无豁免，禁止自己回答。'
                : '【委派模式已关闭】用户已关闭委派开关：恢复常规行为——任务由你直接处理，仅在用户明确点名外部智能体（codex/hy3/wbmodel/claude）时才调用 agent_dispatch。'
          const message = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-agent-selector' },
          }
          try {
            if (typeof agent.followup === 'function') agent.followup(message)
            else if (agent.inbox && typeof agent.inbox.append === 'function') agent.inbox.append(message)
            else return done({ ok: false, error: 'agent has no followup/inbox' })
            return done({ ok: true, result: { on, dmode, sessionId, combo, delegateMode: cfgAfterSet.delegateMode } })
          } catch (e) {
            return done({ ok: false, error: 'followup failed: ' + String(e && e.message || e) })
          }
        }
        if (method === 'config.get') return done({ ok: true, result: loadConfig(typeof args.sessionId === 'string' ? args.sessionId : '') })
        if (method === 'config.set') return done({ ok: true, result: saveConfig(typeof args.sessionId === 'string' ? args.sessionId : '', (args.config || {})) })
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

  // ---- 委派模式守卫（v0.1.5 后置加固）：解决"宣告一次被模型遗忘"的偷懒问题 ----
  // 监听 user/message：delegateMode=true 时，每条 user 消息前都即时 followup 强约束提示。
  // 偷懒一次就被点醒一次；切换回 OFF 后零成本。followup 形态走 multi-role-debate 已验证的
  // agents.get(sessionId) + 规范 UserMessage（content blocks + source.plugin 标签防二次触发）。
  try {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'user/message') return
      const msg = event.data || {}
      const src = msg.source
      // v0.2.3 修复 4：**只认真人消息**。compaction 摘要、系统注入、子代理回填等也会以
      // user/message 事件形态出现，但 source.kind 不是 'user'。不过滤就会形成守卫自激环
      // （multi-role-debate v0.2.3 同款：摘要触发守卫 → 守卫注入消息 → 又抬升上下文触发摘要）。
      if (!src || src.kind !== 'user') return
      // 防二次触发：本插件自己注入的消息（含 mode.announce 和守卫提示）都跳过，
      // 否则每次本插件提示自己又被守卫监听触发，形成无限循环。
      if (src.plugin === 'dsh-agent-selector') return
      const sessionId = session && session.id
      if (!sessionId) return
      // v0.2.2: 子代理裸 uuid 会话不注入（AgentRegistry 格式必须是 session-<uuid>；
      // 子代理消息进入守卫视野只会刷日志，无法 followup，直接跳过保持干净）
      if (!/^session-/.test(sessionId)) return
      // v0.1.6/v0.1.7: per-session delegateMode（0=OFF/1=ON 任务类/2=FULL 全托管）——A 会话不污染 B 会话
      const dmode = loadConfig(sessionId).delegateMode | 0
      if (!dmode) return
      // v0.1.9b: observed log — console.log FIRST (dsh-web-service.log captures stdout; ctx.logger does NOT land there)
      console.log("[agent-selector] guard observed user message session=" + sessionId)
      // v0.1.5b: guard fires for every user message when per-session mode is ON, so the session model can't quietly skip delegation by "lazy answering" itself.
      const agents = ctx.get('agents')
      let agent = (agents && agents.get) ? agents.get(sessionId) : null
      if (!agent || typeof agent.followup !== 'function') {
        // v0.1.9c: cold-activation fallback (self-restart verified path) — the target
        // session may not be loaded in the registry yet; resolveAgent resumes it with
        // its full persisted preset so followup works.
        try {
          const sc = ctx.get('sessionController')
          if (sc && typeof sc.resolveAgent === 'function') agent = sc.resolveAgent(sessionId)
        } catch (e) { console.error('[agent-selector] resolveAgent fallback failed: ' + String(e && e.message || e)) }
      }
      if (!agent || typeof agent.followup !== 'function') return
      const cfg = loadConfig(sessionId)
      const combo = cfg.defaultTarget === 'hy3' ? 'hy3 · ' + (cfg.hy3Model || 'hy3')
        : cfg.defaultTarget === 'wbmodel' ? 'wbmodel · ' + (cfg.wbCustomModel || '未选')
        : cfg.defaultTarget === 'claude-code' ? 'claude-code · ' + (cfg.claudeModel || 'deepseek-v4-pro')
        : 'codex · ' + (cfg.codexModel || 'gpt-5.6-terra')
      const tierNote = dmode === 1 ? '（档位：仅查看——禁止修改项目文件）' : dmode === 2 ? '（档位：工作区内修改——允许改当前工作区文件）' : '（档位：完全权限）'
      const text = '【强约束 · 委派模式守卫】用户刚发送了上面的消息。你必须通过 agent_dispatch 工具（target="auto"）委派给 ' + combo + ' 执行' + tierNote + '。\n' +
        '【必做】① 立即调用 agent_dispatch，target="auto"，task=把用户这条消息打包为自包含 brief（会话记忆仅携带最近若干轮的截断摘要、非全文——涉及具体文件、函数、错误原文、代词所指对象的一律在 brief 里补全，不要依赖执行体记得住）；② 转述 agent_dispatch 返回的受理确认给用户；委派结果送达后（以 dsh-agent-selector 来源的消息出现为准）将结果转述给用户。\n' +
        '③【审查闭环】收到委派结果后，若发现任何需要修改/修正/完善的地方（包括代码审查发现的问题），必须再次调用 agent_dispatch 交回 ' + combo + ' 执行——审查与修正也属于委派范围，禁止自己直接修改文件、代码或配置；只有结果无需任何修改时才原样转述。\n' +
        '【禁做】禁止自己回答、禁止省略 tool call、禁止编造结果、禁止在审查环节亲自修改。委派失败如实报告。'
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-agent-selector' },
      }
      try { agent.followup(message) }
      catch (e) {
        if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn("agent-selector delegate guard followup failed: " + String(e && e.message || e))
        else console.error("agent-selector delegate guard followup failed: " + String(e && e.message || e))
        return
      }
      console.log("[agent-selector] GUARD FIRED session=" + sessionId + " combo=" + combo)
    }))
  } catch (e) {
    console.error("[agent-selector] delegate guard SETUP FAILED: " + String(e && e.message || e))
  }
}
