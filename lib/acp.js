/**
 * dsh-agent-selector — ACP 会话通道（v0.2.0 · 阶段 2 核心）
 *
 * 让 DSH 通过 WorkBuddy Web 后端的 ACP（Agent Client Protocol）在**既有会话**上续聊，
 * 拿到原生多轮记忆，绕过 automation 桥的"新建 automation 行 → 等调度器 tick"的分钟级延迟。
 *
 * ── 协议事实（2026-09-05 本机实测，探针见 wb-bridge-experiment/acp_probe*.mjs）──
 *   1. `POST {url}/api/v1/acp/connect` 零鉴权 → { connectionId, sessionToken }
 *   2. 其余请求 `POST {url}/api/v1/acp`，头必须带 `acp-connection-id` + `acp-session-token`；
 *      body = JSON-RPC 2.0 { jsonrpc, id, method, params }
 *   3. **响应体是 SSE**（`data: {...}\n\n`）：同一条流里混着 notification（无 id 的
 *      session/update）与服务端反向请求（有 id 且有 method），最后一条 id 匹配的才是本次结果
 *   4. 服务端反向调用 `session/request_permission` / `_codebuddy.ai/question` 必须应答，否则
 *      工具调用静默挂死。应答字段值从 Web bundle 实读确认：
 *      权限 `{outcome:{outcome:"selected",optionId}}`（optionId 枚举 allow/allow_always/reject…）、
 *      提问 `{outcome:"submitted",answers:{[qid]:label}}`
 *   5. Web server 端点靠 `~/.workbuddy/sessions/<pid>.json` 的 `url` 字段发现，**禁止硬编码端口**
 *
 * ── 会话历史机理（2026-09-05 六组对照实测，探针与日志见 wb-bridge-experiment/acp_*.mjs|log）──
 *   ✅ 同连接连发两轮 prompt → 记忆正常。
 *   ✅ 新连接 session/load 同一 sessionId → 记忆正常（宿主项目目录 cwd 与陌生任务目录 cwd 均通过）。
 *   ✅ 跨进程续聊：换 node 进程 load 既有 sessionId → 记忆正常（创建者连接 DELETE 过、
 *      或从未 DELETE 直接进程退出，两种都测过，均成功）。
 *   ⚠️ 因此 **DELETE 不是"丢历史"的根因**。v0.2.0 曾观测到"prompt 后立即 DELETE → 下一轮空
 *      上下文"并据此写下"DELETE 会带走历史"，2026-09-05 复现时**得到反例**（DELETE 返回 200，
 *      新连接 load 仍能完整回忆），该结论已降级为"相关但非因果"，根因未完全定位
 *      （怀疑与宿主会话回收时序/并发连接数有关，非 DELETE 本身）。
 *   ⚠️ **ACP 会话不落盘**：实测所有 ACP 新建的 sessionId 都不会在
 *      `~/.workbuddy/projects/<proj>/<sid>.jsonl` 生成文件（`session/load` 也不回吐 transcript）。
 *      历史只在 WorkBuddy 宿主的**内存态**里 ⇒ 宿主重启/崩溃 ⇒ 历史全部蒸发，
 *      且跨进程续聊**不是 100% 可靠**（六组里有一组冷启动 load 拿到空上下文）。
 *      ⇒ 结论：池化复用（不 DELETE）让**同进程内**的多轮续聊稳定可用，这是本插件的主场景；
 *        但不要把 `acpSessionId` 当成可靠的长久记忆凭证，宿主重启后应视为可能失忆。
 *
 * ⚠️ 安全：ACP 端点零鉴权 = 本机任意进程可驱动 agent 完整工具能力。本模块只在 DSH 宿主进程内
 * 调用（loopback），不得把 connect 凭据外传。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SESSIONS_DIR = path.join(os.homedir(), '.workbuddy', 'sessions')
const CLIENT_INFO = { name: 'dsh-agent-selector', version: '0.2.0' }
// optionId 枚举（Web bundle 实读：mapPermissionDecisionToOptionId 的映射值）
const ALLOW_OPTION_IDS = ['allow', 'allow_once', 'allow_always', 'proceed', 'accept', 'yes']
const POOL_MAX = 8 // 连接池上限；淘汰时**优先淘汰非创建者**（创建者被 DELETE 会带走会话历史）
// session/new 不保证返回空白会话（实测某宿主会先递出"最近用过的会话"），最多重试几次
// v0.3.2（R6）：3→2——每轮 new(60s)+chk(15s) 最坏 75s，3 轮前置可吃 270s 死线，
// prompt 被挤到保底裸奔。探针 10 的脏会话命中率 1/4，2 轮逃逸概率已约 94%。
const NEW_MAX_TRIES = 2

/** 连接池：key(DSH 会话) → { endpoint, connectionId, sessionToken, acpSessionId, created, headers, lastUsed, nextId }
 *  v0.3.1：挂到 globalThis——双 apply/双 entry 场景下模块可能被加载两次，
 *  两个模块级 POOL 会把同一 acpSessionId 切成两条连接并发 prompt（服务端行为未定义，可挂起）。 */
const POOL = globalThis.__dshAgentSelectorAcpPool || (globalThis.__dshAgentSelectorAcpPool = new Map())
/** prompt 级活动看门狗：超过此时长没有任何帧（含心跳/通知）即提前收流并带诊断抛错。
 *  v0.3.2：240s→360s——thinking 模型长考静默 4 分钟属正常（帧=chunk 才重置看门狗），
 *  240s 会误杀长考中的 prompt，触发无谓的桥回退（R2）。可用 opts.idleMs 覆盖。 */
const ACP_IDLE_MS = 360000

function clip0(s, n) { return String(s == null ? '' : s).slice(0, n) }

// ---- v0.2.1: 推理档位（effort）→ session/set_config_option("thought_level") ----
// bundle 实读（wb-bridge-experiment）：configOptions=[{id,currentValue,options}]，
// id 枚举含 thought_level；Web UI 切挡位即调 session/set_config_option。
// 档位合法值由服务端下发（bundle 无硬编码），故 options 必须动态读取、语义匹配。
function effortValueOf(opt) {
  if (opt == null) return ''
  if (typeof opt !== 'object') return String(opt)
  const v = opt.value != null ? opt.value : (opt.id != null ? opt.id : (opt.name != null ? opt.name : opt.label))
  return v == null ? '' : String(v)
}

/** 语义档位（off/standard/high）→ thought_level.options 里的实际值；匹配不到返回 null */
function matchEffort(effort, options) {
  if (!Array.isArray(options) || !options.length) return null
  const vals = options.map(effortValueOf).filter(Boolean)
  if (!vals.length) return null
  const e = String(effort)
  const direct = vals.find((v) => v.toLowerCase() === e.toLowerCase())
  if (direct != null) return direct
  if (e === 'off') {
    const o = vals.find((v) => /off|disabled|none|关闭/i.test(v))
    return o || vals[0]
  }
  if (e === 'high') {
    const o = vals.find((v) => /high|max|最高/i.test(v))
    return o || vals[vals.length - 1]
  }
  return vals[Math.floor((vals.length - 1) / 2)] // standard → 中间项
}

/**
 * 宿主指纹：url + 宿主 sessionId + pid。
 * 实测每次 WorkBuddy 宿主启动三者全变 ⇒ 可用于判断"宿主是否重启过"。
 * acpDispatch 会把它回传给调用方持久化，下次调用时比对。
 */
function hostFingerprint(ep) {
  return [ep && ep.url, ep && ep.sessionId, ep && ep.pid].filter(Boolean).join('|')
}

/** 从宿主指纹里取出上次使用的端点 url（格式 `url|sessionId|pid`），用于粘性端点发现 */
function preferUrlOf(knownHostToken) {
  const t = String(knownHostToken || '')
  if (!t) return ''
  const i = t.indexOf('|')
  return i > 0 ? t.slice(0, i) : ''
}

/**
 * 端点发现：扫 ~/.workbuddy/sessions/*.json。
 * 覆盖优先级：opts.baseUrl > 环境变量 DSH_ACP_URL > 会话目录扫描。
 *
 * ⚠️ 多宿主横跳（2026-09-05 实测）：本机常同时跑着多个 WorkBuddy 宿主（如 :36140 与 :12434），
 * 而 `lastHeartbeat` **只在有请求时才写**（实测空闲 12s 完全不更新，staleMs 从 5s 涨到 17s）。
 * 因此一律"取 heartbeat 最新者"会在宿主之间来回横跳，每次横跳都白丢一个会话。
 * → 提供 `opts.preferUrl`：只要该 url 还在候选里就优先复用（不看新鲜度），
 *   存活与否由 `connect` 探活决定（宿主死了 connect 会失败，见 acpDispatch 的粘性回退）。
 */
export function discoverEndpoint(opts = {}) {
  const override = (opts && opts.baseUrl) || process.env.DSH_ACP_URL || ''
  if (override) {
    return { url: String(override).replace(/\/+$/, ''), pid: 0, sessionId: '', cwd: '', lastHeartbeat: 0, source: 'override' }
  }
  let names = []
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'))
  } catch (e) {
    throw new Error('ACP 端点发现失败：读不到会话目录 ' + SESSIONS_DIR + '（' + (e && e.message ? e.message : e) + '）——WorkBuddy 未运行？')
  }
  const cands = []
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8'))
      const url = typeof j.url === 'string' && j.url ? j.url : (typeof j.endpoint === 'string' ? j.endpoint : '')
      if (!url) continue // prewarm 行无 url
      cands.push({
        url: String(url).replace(/\/+$/, ''),
        pid: j.pid || 0,
        sessionId: j.sessionId || '',
        cwd: j.cwd || '',
        lastHeartbeat: Number(j.lastHeartbeat) || 0,
        source: 'sessions-dir',
      })
    } catch { /* 坏 JSON 行跳过 */ }
  }
  if (!cands.length) throw new Error('ACP 端点发现失败：' + SESSIONS_DIR + ' 下无任何带 url 的会话（WorkBuddy 未运行或未监听 HTTP）')
  cands.sort((a, b) => b.lastHeartbeat - a.lastHeartbeat)
  // 粘性：上次用过的端点只要还在候选里就继续用（存活由 connect 探活，不看 heartbeat）
  const prefer = String((opts && opts.preferUrl) || '').trim()
  if (prefer) {
    const hit = cands.find((c) => c.url === prefer)
    if (hit) {
      hit.staleMs = Math.max(0, Date.now() - hit.lastHeartbeat)
      hit.sticky = true
      return hit
    }
  }
  cands[0].staleMs = Math.max(0, Date.now() - cands[0].lastHeartbeat)
  return cands[0]
}

/** SSE 流读取：解析 `data: {...}\n\n`（v0.3.1 兼容 \r\n 帧分隔），onMsg 返回 false 可提前收流。
 *  opts.idleMs>0 启用活动看门狗：超过 idleMs 没有任何帧（含心跳/通知）即提前收流（idleTripped=true）——
 *  区分"服务端在长考"与"流早已静默死亡"，不再一律干等到总预算耗尽。
 *  opts.stopWhen：外部收流判据（v0.3.2），每 250ms tick 评估一次——终帧被别的流代收时主流能及时收，
 *  不再干等 idle 看门狗。实现要点：全程只有一个 pending read（tick 轮询期间 readP 不重建），
 *  多次 read() 会在流上排队错乱，禁止那么写。
 *  返回 { frames, lastFrameAt, idleTripped } 供调用方拼超时诊断。 */
async function drainStream(res, onMsg, timeoutMs, opts) {
  const body = res && res.body
  if (!body || typeof body.getReader !== 'function') throw new Error('ACP 响应无流式 body（不是 SSE？）')
  const stats = { frames: 0, lastFrameAt: Date.now(), idleTripped: false }
  const idleMs = Math.max(0, (opts && opts.idleMs) || 0)
  const stopWhen = (opts && typeof opts.stopWhen === 'function') ? opts.stopWhen : null
  const reader = body.getReader()
  const dec = new TextDecoder()
  const TICK = Symbol('tick')
  let buf = ''
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}) } catch { /* 忽略 */ }
  }
  const timer = setTimeout(stop, Math.max(1000, timeoutMs || 30000))
  let idleTimer = null
  const armIdle = () => {
    if (!idleMs) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stats.idleTripped = true; stop() }, idleMs)
  }
  armIdle()
  try {
    let readP = reader.read()
    for (;;) {
      let r
      try { r = await Promise.race([readP, new Promise((res2) => setTimeout(() => res2(TICK), 250))]) } catch { break } // 流被 cancel / 连接断开
      if (r === TICK) {
        if (stopWhen) { try { if (stopWhen()) break } catch { /* 判据异常不阻断 */ } }
        continue // readP 仍 pending，下轮继续 race 同一个
      }
      readP = reader.read()
      if (r.done) break
      buf += dec.decode(r.value, { stream: true })
      let m
      const re = /\r?\n\r?\n/
      while ((m = re.exec(buf))) {
        const raw = buf.slice(0, m.index)
        buf = buf.slice(m.index + m[0].length)
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data || data === '[DONE]') continue
        let msg = null
        try { msg = JSON.parse(data) } catch { continue }
        stats.frames++
        stats.lastFrameAt = Date.now()
        armIdle()
        if (onMsg(msg) === false) { clearTimeout(timer); if (idleTimer) clearTimeout(idleTimer); stop(); return stats }
      }
    }
  } finally {
    clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
    stop()
  }
  return stats
}

/** 权限应答：优先 allow 类 optionId，其次名字带"允许"的，再次第一个非拒绝项 */
function permOutcome(params) {
  const options = Array.isArray(params && params.options) ? params.options : []
  const idOf = (o) => String((o && (o.optionId != null ? o.optionId : o.id)) || '').toLowerCase()
  const nameOf = (o) => String((o && (o.name != null ? o.name : o.label)) || '')
  const allow = options.find((o) => ALLOW_OPTION_IDS.includes(idOf(o))) ||
    options.find((o) => /allow|允许|批准|同意|继续/i.test(nameOf(o))) ||
    options.find((o) => !/reject|deny|cancel|拒绝|取消|不允许/i.test(idOf(o) + ' ' + nameOf(o)))
  const chosen = allow || options[0]
  if (!chosen || (chosen.optionId == null && chosen.id == null)) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId != null ? chosen.optionId : chosen.id } }
}

/** AskUserQuestion 类应答：每题选第一个选项 */
function questionAnswers(params) {
  const qs = (params && (params.schema ? params.schema.questions : params.questions)) || []
  const answers = {}
  for (const q of Array.isArray(qs) ? qs : []) {
    if (!q || q.id == null) continue
    const opts = Array.isArray(q.options) ? q.options : []
    const first = opts[0]
    answers[q.id] = first ? String(first.label != null ? first.label : (first.value != null ? first.value : first.id)) : ''
  }
  return { outcome: 'submitted', answers }
}

function poolGet(key, url, acpSessionId, hostToken) {
  const e = POOL.get(key)
  if (!e) return null
  // v0.3.2（R5）：busy 闸——同 poolKey 并发委派不抢同一条连接（同一 connectionId 上
  // 并发 prompt 服务端行为未定义，可挂起，LESSONS 已记）。命中 busy 返回 null 走新建；
  // 新建 entry poolPut 时覆盖 Map 同键，旧连接由服务端 GC（可接受的泄漏，胜过硬等）。
  if (e.busy) return null
  if (e.endpoint !== url) { POOL.delete(key); return null }
  if (hostToken && e.hostToken && e.hostToken !== hostToken) { POOL.delete(key); return null }
  if (acpSessionId && e.acpSessionId && e.acpSessionId !== acpSessionId) { POOL.delete(key); return null }
  e.lastUsed = Date.now()
  return e
}

function poolPut(key, entry) {
  entry.lastUsed = Date.now()
  POOL.set(key, entry)
  if (POOL.size <= POOL_MAX) return
  // LRU 淘汰：**跳过创建者**（DELETE 创建者连接会带走该会话的历史），只淘汰 load 型连接
  const sorted = [...POOL.entries()].sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0))
  for (const [k, e] of sorted) {
    if (POOL.size <= POOL_MAX) break
    if (k === key) continue
    if (e.created) continue // 创建者不淘汰，宁可超上限也不丢会话历史
    POOL.delete(k)
    closeConn(e).catch(() => {})
  }
}

async function closeConn(entry) {
  if (!entry) return
  try {
    await fetch(entry.endpoint + '/api/v1/acp', {
      method: 'DELETE',
      headers: entry.headers,
      signal: AbortSignal.timeout(5000),
    })
  } catch { /* 忽略 */ }
}

/** 显式关闭并丢弃某条池化连接（例如切换工作区/重置对话）。注意：关闭创建者会带走该会话历史 */
export async function acpClose(key) {
  const e = POOL.get(String(key || ''))
  if (!e) return false
  POOL.delete(String(key || ''))
  await closeConn(e)
  return true
}

/** 池状态（供治理/RPC 观测） */
export function acpPoolStatus() {
  return [...POOL.entries()].map(([k, e]) => ({
    key: k, endpoint: e.endpoint, acpSessionId: e.acpSessionId, created: !!e.created,
    lastUsed: e.lastUsed, idleMs: Date.now() - (e.lastUsed || 0),
  }))
}

/**
 * 权威模型清单（v0.2.3 · 修复 1）。
 *
 * 来源：ACP session/new 的 result.models.availableModels——这是 WorkBuddy 宿主自己下发的
 * 当前在售模型全集（含显示名 name 与计价 credits），比 automation 桥的
 * "sessions.model ∪ automations.model_id 反推"权威得多（后者只能看到本机用过的模型）。
 *
 * ⚠️ session/new 每次都真建一个新会话（不能频繁打），故模块级 TTL 缓存 10 分钟；
 * 过期后下一次调用重新拉取。失败直接抛错——由调用方（agents.list）回退下一级清单，
 * 本模块不做静默兜底，避免把坏数据当好数据。
 *
 * @param {object} [opts] { baseUrl?, preferUrl?, timeoutMs? }
 * @returns {Promise<Array<{modelId:string,name:string,credits:*}>>}
 */
const MODELS_TTL_MS = 10 * 60 * 1000
let _modelsCache = { at: 0, data: null }

export async function acpListModels(opts = {}) {
  if (_modelsCache.data && Date.now() - _modelsCache.at < MODELS_TTL_MS) return _modelsCache.data
  const ep = discoverEndpoint({ baseUrl: opts.baseUrl, preferUrl: opts.preferUrl })
  const base = ep.url
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000

  // 独立连接（不走 POOL）：本函数只读元数据，不承载续聊会话
  let connectionId = '', sessionToken = ''
  try {
    const cr = await fetch(base + '/api/v1/acp/connect', {
      method: 'POST',
      headers: { 'x-codebuddy-request': '1' },
      signal: AbortSignal.timeout(15000),
    })
    if (!cr.ok) throw new Error('HTTP ' + cr.status + ' ' + clip0(await cr.text().catch(() => ''), 200))
    const grant = await cr.json()
    if (!grant || !grant.connectionId) throw new Error('connect 返回缺少 connectionId')
    connectionId = grant.connectionId
    sessionToken = grant.sessionToken || ''
  } catch (e) {
    throw new Error('ACP acpListModels connect 失败（' + base + '）：' + (e && e.message ? e.message : e))
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-codebuddy-request': '1',
    'acp-connection-id': connectionId,
    'acp-session-token': sessionToken,
  }

  let idSeq = 1
  const pending = [] // 反向调用应答（v0.3.1：session/new 期间也可能来权限请求，不应答会挂到预算耗尽）
  async function answer(req) {
    try {
      const method = String((req && req.method) || '')
      let result = null
      let errPayload = null
      if (method === 'session/request_permission') result = permOutcome(req.params)
      else if (method === '_codebuddy.ai/question') result = questionAnswers(req.params)
      else errPayload = { code: -32601, message: 'Unsupported method: ' + method }
      const payload = errPayload
        ? { jsonrpc: '2.0', id: req.id, error: errPayload }
        : { jsonrpc: '2.0', id: req.id, result }
      const res = await fetch(base + '/api/v1/acp', {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
      })
      if (res.ok) await drainStream(res, () => {}, 5000).catch(() => {})
    } catch { /* 尽力 */ }
  }
  async function rpc(method, params, ms) {
    const id = idSeq++
    const budget = Math.max(1000, ms || timeoutMs)
    const res = await fetch(base + '/api/v1/acp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(budget),
    })
    if (!res.ok) throw new Error('ACP ' + method + ' → HTTP ' + res.status + ' ' + clip0(await res.text().catch(() => ''), 200))
    let final = null
    await drainStream(res, (m) => {
      if (!m || typeof m !== 'object') return
      if (m.id != null && m.method) { pending.push(answer(m)); return } // 服务端 → 客户端请求
      if (m.id === id && !m.method) { final = m; return false }
    }, budget)
    if (!final) throw new Error('ACP ' + method + ' 超时未收到结果响应（' + budget + 'ms）')
    if (final.error) throw new Error('ACP ' + method + ' 错误 ' + final.error.code + ': ' + final.error.message)
    return final
  }

  try {
    await rpc('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      clientCapabilities: { _meta: { 'codebuddy.ai': { mainAgentSupport: true } } },
    }, 30000)
    const cwd = (ep && ep.cwd) || process.cwd()
    const nr = await rpc('session/new', { cwd, mcpServers: [] }, timeoutMs)
    const result = (nr && nr.result) || {}
    const avail = result.models && Array.isArray(result.models.availableModels) ? result.models.availableModels : null
    if (!avail) throw new Error('session/new 结果缺 models.availableModels：' + clip0(JSON.stringify(result).slice(0, 300), 300))
    const models = avail
      .filter((m) => m && typeof m.modelId === 'string' && m.modelId && !m.modelId.startsWith('custom-local:'))
      .map((m) => ({ modelId: m.modelId, name: m.name || m.modelId, credits: m.credits }))
    if (!models.length) throw new Error('availableModels 过滤后为空')
    _modelsCache = { at: Date.now(), data: models }
    return models
  } finally {
    // 收尾删连接（本连接上只建过一个一次性会话，DELETE 不影响其它会话——文件头六组对照已证）
    await Promise.allSettled(pending)
    try {
      await fetch(base + '/api/v1/acp', {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* 忽略 */ }
  }
}

/**
 * ACP 委派主入口。
 * @param {object} opts { task, cwd, acpSessionId?, poolKey?, dmode?, timeoutMs?, baseUrl?, knownHostToken?, effort?, model?, onUpdate? }
 *   onUpdate(evt)：过程事件外抛（v0.3.0 过程流面板）。evt={kind:'thought'|'message'|'tool', text, ts}。
 *   收 agent_thought_chunk / agent_message_chunk / tool_call(_update) 三类 chunk；不传则行为不变。
 *   回调异常一律吞掉，绝不影响主流。
 *   effort：推理档位（"off"|"standard"|"high"，空=不设）。session/new|load 后从 result.configOptions
 *   找 thought_level 项做语义匹配，prompt 前 set_config_option 下发；匹配失败只标注不阻断。
 *   model：模型 id（如 'kimi-k3-2'/'hy3'，空=不设）。v0.2.3 修复 3 实测：configOptions 里
 *   存在 id==='model' 的 select 项，session/set_config_option 可写（跨进程 session/load 回读
 *   currentValue 已变更，探针 wb-bridge-experiment/acp_probe_model.mjs）。
 *   校验：value 必须在 session/new|load 的 result.models.availableModels[].modelId 里，
 *   不在则跳过并标注 modelApplied:false（避免把非法值写进服务端）。
 *   poolKey：连接池键（建议传 DSH 会话 id）——同一 poolKey 复用同一条 ACP 连接与会话，
 *   多轮历史才在。不传则退化为"按 acpSessionId/单例"复用。
 *   knownHostToken：上次调用返回的 `hostToken`（宿主指纹）。回传它做两件事：
 *     ① 空上下文自检（指纹变了 ⇒ 宿主重启过 ⇒ 弃用旧 acpSessionId 强制新建）；
 *     ② 粘性端点（优先复用上次那个宿主，避免多宿主并存时横跳）。
 * @returns {Promise<{text, acpSessionId, durationMs, endpoint, sessionMode, stopReason, reused, hostToken, hostChanged, sessionBlank}>}
 */
export async function acpDispatch(opts = {}) {
  const task = String((opts && opts.task) || '').trim()
  if (!task) throw new Error('acpDispatch 需要非空 task')
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 300000
  const cwd = String((opts && opts.cwd) || '').trim() || process.cwd()
  const wantedSessionId = String((opts && opts.acpSessionId) || '').trim()
  const key = String((opts && opts.poolKey) || '').trim() || (wantedSessionId ? 'sid:' + wantedSessionId : '__default__')
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  const left = () => Math.max(1000, deadline - Date.now())

  // 粘性端点：上次连过的 url 优先复用，避免在多个并存的 WorkBuddy 宿主之间横跳
  const preferUrl = preferUrlOf(opts.knownHostToken)
  let ep = discoverEndpoint({ baseUrl: opts.baseUrl, preferUrl })
  let stickied = !!preferUrl && ep.url === preferUrl

  // ── 空上下文自检 · 宿主指纹 ──────────────────────────────────────────────
  // ACP 会话历史只在宿主进程内存里（不落盘），宿主一重启，上次持久化的 acpSessionId
  // 就成了"能 load 但上下文为空"的**静默失败**——从协议层看不出来：
  //   · session/load 对**不存在**的 sessionId 也返回 200 且无 error；
  //   · sessionBlank 也无法区分（换连接 load 一个有历史的会话同样是 true）。
  // 唯一可靠的外部判据是**宿主指纹**：实测每次宿主启动，pid / sessionId / 端口三者全变。
  // → 指纹变了就认定旧会话已死，强制 session/new，绝不带旧 id 去"假续聊"。
  let hostToken = hostFingerprint(ep)
  const knownHostToken = String((opts && opts.knownHostToken) || '').trim()
  let hostChanged = !!knownHostToken && knownHostToken !== hostToken
  let sessionIdWanted = wantedSessionId
  if (hostChanged) {
    console.error('[agent-selector] ACP 宿主指纹已变（' + clip0(knownHostToken, 60) + ' → ' + clip0(hostToken, 60) +
      '）：宿主可能重启，旧的 acpSessionId 已失效，改用新会话')
    sessionIdWanted = ''
  }

  // 失败重试：① 粘性端点探活失败 → 重新发现端点；② 复用连接失效 → 作废重建。用完即抛。
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    // v0.2.3 修复 5：剩余预算不足 30s 时不再进重试。一次重建要重走
    // connect+initialize+session/new(+load)+prompt，数秒起步；预算只剩零头时重试必然再超时，
    // 只会把有效错误信息（原始错误）换成一句无用的 "超时未收到结果响应"。直接抛原始错误。
    if (attempt > 0 && left() < 30000) {
      const orig = lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'ACP 重试预算耗尽'))
      orig.message = (orig.message || 'ACP 重试预算耗尽') + '（剩余预算不足 30s，放弃重试）'
      throw orig
    }
    const reused = poolGet(key, ep.url, sessionIdWanted, hostToken)
    try {
      return await runOnce(ep, reused, { task, cwd, wantedSessionId: sessionIdWanted, key, left, t0, hostToken, hostChanged, effort: String((opts && opts.effort) || ''), model: String((opts && opts.model) || ''), onUpdate: (opts && typeof opts.onUpdate === 'function') ? opts.onUpdate : null })
    } catch (e) {
      lastErr = e
      const msg = (e && e.message) || String(e)
      // 粘性端点已死（宿主退出但会话文件残留）→ 放弃粘性，重新发现后重试
      if (stickied && msg.indexOf('ACP connect 失败') === 0) {
        stickied = false
        POOL.delete(key)
        ep = discoverEndpoint({ baseUrl: opts.baseUrl })
        hostToken = hostFingerprint(ep)
        hostChanged = true
        sessionIdWanted = ''
        console.error('[agent-selector] ACP 粘性端点已失效（' + clip0(msg, 160) + '），改用新发现端点 ' + ep.url)
        continue
      }
      if (reused) {
        // 复用连接出错（多半是服务端把连接回收了）→ 作废重建，重试一次
        POOL.delete(key)
        console.error('[agent-selector] ACP 复用连接失败，重建后重试: ' + clip0(msg, 200))
        continue
      }
      throw e instanceof Error ? e : new Error(msg)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function runOnce(ep, reused, o) {
  const { task, cwd, wantedSessionId, key, left, t0, hostToken, hostChanged, effort, model, onUpdate, idleMs } = o
  const base = ep.url
  let entry = reused
  let cfgModels = null // session/new|load result.models.availableModels（modelId 白名单的唯一权威来源）
  let sessionBlank = null // session/load 返回：false=上下文非空（确定）；true=未知（换连接时正常）
  let sessionReused = false // session/new 返回了一个"并非空白"的会话（上下文可能混入无关历史）
  let newTries = 0 // 本次 session/new 尝试次数（>1 表示重试过）
  const pending = [] // 反向调用应答（fire-and-forget，结束前统一 await）

  if (!entry) {
    let grant
    try {
      const cr = await fetch(base + '/api/v1/acp/connect', {
        method: 'POST',
        headers: { 'x-codebuddy-request': '1' },
        signal: AbortSignal.timeout(Math.min(15000, left())),
      })
      if (!cr.ok) throw new Error('HTTP ' + cr.status + ' ' + clip0(await cr.text().catch(() => ''), 200))
      grant = await cr.json()
    } catch (e) {
      throw new Error('ACP connect 失败（' + base + '）：' + (e && e.message ? e.message : e))
    }
    if (!grant || !grant.connectionId) throw new Error('ACP connect 返回缺少 connectionId：' + clip0(JSON.stringify(grant), 200))
    entry = {
      endpoint: base,
      hostToken: hostToken || '',
      connectionId: grant.connectionId,
      sessionToken: grant.sessionToken || '',
      acpSessionId: wantedSessionId || '',
      created: false,
      initialized: false,
      nextId: 0, // JSON-RPC id 计数器挂在连接上：复用连接跨委派单调递增，不再每轮重置为 1
    }
    entry.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-codebuddy-request': '1',
      'acp-connection-id': entry.connectionId,
      'acp-session-token': entry.sessionToken,
    }
  }

  // 宿主指纹变化 ⇒ **连池里已存在的连接所挂的旧会话同样失效**。
  // 只把 wantedSessionId 置空是不够的：runOnce 走复用分支时看的是 entry.acpSessionId，
  // 不清它就会拿着旧 id 去 session/load，正好是我们要防的"假续聊"。
  if (hostChanged && entry && entry.acpSessionId) {
    entry.acpSessionId = ''
    entry.created = false
  }

  async function post(payload, ms) {
    const res = await fetch(base + '/api/v1/acp', {
      method: 'POST',
      headers: entry.headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1000, ms || 30000)),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = clip0(await res.text(), 300) } catch { /* 忽略 */ }
      throw new Error('ACP POST ' + payload.method + ' → HTTP ' + res.status + ' ' + detail)
    }
    return res
  }

  /** 反向调用自动应答：不响应 → 工具调用静默挂死 */
  async function respond(req) {
    const method = String((req && req.method) || '')
    let result = null
    let errPayload = null
    try {
      if (method === 'session/request_permission') {
        result = permOutcome(req.params)
      } else if (method === '_codebuddy.ai/question') {
        result = questionAnswers(req.params)
      } else if (method === '_codebuddy.ai/delegateTool') {
        result = { status: 'error', error: { message: 'delegateTool unsupported by dsh-agent-selector ACP client' } }
      } else {
        errPayload = { code: -32601, message: 'Unsupported method: ' + method }
      }
      const payload = errPayload
        ? { jsonrpc: '2.0', id: req.id, error: errPayload }
        : { jsonrpc: '2.0', id: req.id, result }
      const res = await post(payload, 30000)
      // v0.3.1 根因修复：应答流**不丢帧**——此前 drainStream(res, () => {}) 把这条流上的
      // 一切帧静默吃掉；服务端只按连接路由出站消息，链式反向调用/通知/甚至 prompt 终帧
      // 若被路由到这条最新流就会被丢弃 → 服务端永等应答 → prompt 挂到 900s。
      // 现统一走 dispatchMsg：链式调用递归应答，通知转发给当前 prompt 的 onNotify。
      // v0.3.2（R4）：预算 30s→8s、idle 10s→5s——服务端对应答无确认帧义务，长尾白等
      // 会叠加到 prompt 尾延迟上（多工具调用任务每条权限应答尾加 10–30s，不可接受）。
      await drainStream(res, (m) => dispatchMsg(m, null), 8000, { idleMs: 5000 }).catch(() => {})
    } catch (e) {
      console.error('[agent-selector] ACP 反向调用应答失败 ' + method + ': ' + (e && e.message ? e.message : e))
    }
  }

  // v0.3.1：统一消息分发——rpc 主流与 respond 应答流走同一套分类逻辑
  let currentNotify = null // 当前进行中 rpc 的 notification 回调（prompt 期间=chunk 聚合器）
  // v0.3.2 根因修复（R1）：服务端只按连接路由出站消息，prompt 终帧（id 匹配的 response）
  // 可能被路由到 respond() 的应答流。此前应答流走 dispatchMsg(m, null) 时这类帧无人承接：
  // 不是反向请求、不匹配 capture（null）、落进 currentNotify 后因取不到 params.update 被无声
  // 丢弃 → 主流永等 final 直到预算耗尽（长任务"卡 900s"的核心症状）。
  // activeCapture 登记当前进行中的 rpc capture：任何流上收到它的终帧都可代为签收；
  // 主流经 drainStream 的 stopWhen 每 250ms 检查 capture.final，代收后 250ms 内收流。
  let activeCapture = null
  function dispatchMsg(m, capture) {
    if (!m || typeof m !== 'object') return
    if (m.id != null && m.method) { pending.push(respond(m)); return } // 服务端 → 客户端请求（含应答流上的链式调用）
    if (capture && m.id === capture.id && !m.method) { capture.final = m; return false }
    if (!capture && activeCapture && m.id != null && !m.method && m.id === activeCapture.id) {
      activeCapture.final = m // 代收被错路由的终帧（R1）
      return false // 收掉这条应答流
    }
    if (typeof currentNotify === 'function') currentNotify(m)
  }

  /** 一次 JSON-RPC：返回 id 匹配的最终响应；onNotify 收 notification */
  async function rpc(method, params, ms, onNotify) {
    const id = (entry.nextId = (entry.nextId || 0) + 1)
    const budget = Math.max(1000, ms || 30000)
    const res = await post({ jsonrpc: '2.0', id, method, params }, budget)
    // 非 SSE 直通：个别响应服务端可能回 application/json 而非事件流，不当流干等
    const ct = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '')
    if (ct.indexOf('text/event-stream') < 0 && ct.indexOf('application/json') >= 0) {
      const m = await res.json().catch(() => null)
      if (!m) throw new Error('ACP ' + method + ' 返回非 SSE 空响应（content-type: ' + clip0(ct, 60) + '）')
      if (m.error) throw new Error('ACP ' + method + ' 错误 ' + m.error.code + ': ' + m.error.message)
      return m
    }
    const capture = { id, final: null }
    const prevNotify = currentNotify
    const prevCapture = activeCapture
    activeCapture = capture // v0.3.2：登记当前 rpc，应答流可代收被错路由的终帧（R1）
    if (typeof onNotify === 'function') currentNotify = onNotify
    let stats = null
    try {
      stats = await drainStream(res, (m) => dispatchMsg(m, capture), budget,
        { idleMs: Math.min(o.idleMs || ACP_IDLE_MS, Math.max(30000, budget - 5000)), stopWhen: () => !!capture.final })
    } finally {
      currentNotify = prevNotify
      activeCapture = prevCapture
    }
    if (!capture.final) {
      const age = stats && stats.lastFrameAt ? Math.round((Date.now() - stats.lastFrameAt) / 1000) : -1
      throw new Error('ACP ' + method + ' 超时未收到结果响应（' + budget + 'ms' +
        (stats && stats.idleTripped ? '，看门狗：' + Math.round(Math.min(ACP_IDLE_MS, Math.max(30000, budget - 5000)) / 1000) + 's 无帧提前收流' : '') +
        '，流帧数=' + (stats ? stats.frames : 0) + '，末帧距今=' + age + 's）')
    }
    if (capture.final.error) throw new Error('ACP ' + method + ' 错误 ' + capture.final.error.code + ': ' + capture.final.error.message)
    return capture.final
  }

  entry.busy = true // v0.3.2（R5）：占用闸，finally 里释放；并发委派经 poolGet 见 busy 走新连接
  try {
    if (!entry.initialized) {
      await rpc('initialize', {
        protocolVersion: 1,
        clientInfo: CLIENT_INFO,
        clientCapabilities: { _meta: { 'codebuddy.ai': { mainAgentSupport: true } } },
      }, Math.min(30000, left()))
      entry.initialized = true
    }

    // 会话：有 acpSessionId → 续聊（session/load）；否则新建
    let cfgOptions = null // session/new|load result.configOptions（档位合法值的唯一权威来源）
    let sessionMode = entry.acpSessionId ? 'load' : 'new'
    if (entry.acpSessionId) {
      const lr = await rpc('session/load', { sessionId: entry.acpSessionId, cwd, mcpServers: [] }, Math.min(60000, left())).catch((e) => ({ __err: e }))
      if (lr && lr.__err) {
        console.error('[agent-selector] ACP session/load 失败，降级 session/new: ' + lr.__err.message)
        entry.acpSessionId = ''
        sessionMode = 'new'
      } else {
        if (lr && lr.result && Array.isArray(lr.result.configOptions)) cfgOptions = lr.result.configOptions
        if (lr && lr.result && lr.result.models && Array.isArray(lr.result.models.availableModels)) cfgModels = lr.result.models.availableModels
        if (lr && lr.result && typeof lr.result.sessionBlank === 'boolean') {
        sessionBlank = lr.result.sessionBlank
        // sessionBlank 语义（2026-09-05 实测）：= 这条连接里是否已展开该会话的 transcript。
        //   false ⇒ 上下文非空（确定的正向信号）
        //   true  ⇒ 未知：换一条新连接 load 有历史的会话同样是 true，所以不能单凭它判"失忆"。
        //   但**复用同一条池化连接**时本应已展开 ⇒ 此时仍为 true 属异常，打日志供排查。
        if (sessionBlank && reused) {
          console.error('[agent-selector] ACP 异常：复用连接上 sessionBlank=true（sid=' + clip0(entry.acpSessionId, 40) +
            '），该连接的会话上下文可能已丢失')
        }
        }
      }
    }
    if (!entry.acpSessionId) {
      // ⚠️ session/new 不保证返回空白会话（2026-09-05 实测：某宿主首次会递出一个带历史的
      // "最近会话"，sid 还反复复现）。判据：同一条连接上，全新空会话 load 的
      // sessionBlank===true。重试判据见探针 10：同一宿主连建 4 个 → 1 脏 3 净 ⇒ 重试有效。
      let fresh = false
      for (let i = 0; i < NEW_MAX_TRIES; i++) {
        newTries = i + 1
        const nr = await rpc('session/new', { cwd, mcpServers: [] }, Math.min(60000, left()))
        if (nr && nr.result && Array.isArray(nr.result.configOptions)) cfgOptions = nr.result.configOptions
        if (nr && nr.result && nr.result.models && Array.isArray(nr.result.models.availableModels)) cfgModels = nr.result.models.availableModels
        const sid = (nr && nr.result && nr.result.sessionId) || ''
        if (!sid) throw new Error('ACP session/new 未返回 sessionId')
        entry.acpSessionId = sid
        entry.created = true
        const chk = await rpc('session/load', { sessionId: sid, cwd, mcpServers: [] }, Math.min(15000, left())).catch(() => null)
        if (chk && chk.result && typeof chk.result.sessionBlank === 'boolean') sessionBlank = chk.result.sessionBlank
        fresh = !!(chk && chk.result && chk.result.sessionBlank === true)
        if (fresh) break
        console.error('[agent-selector] ACP session/new 第 ' + newTries + ' 次返回非空白会话（sid=' + clip0(sid, 40) + '），重试')
      }
      if (!fresh) {
        sessionReused = true
        console.error('[agent-selector] ACP 警告：连试 ' + newTries + ' 次 session/new 均未拿到空白会话，上下文可能混入无关历史')
      }
    }

    // 推理档位：session 定型后、prompt 之前设 thought_level（失败/缺项不阻断，只标注）
    let effortApplied = false
    let effortValue = ''
    if (effort && entry.acpSessionId) {
      const co = Array.isArray(cfgOptions) ? cfgOptions.find((c) => c && c.id === 'thought_level') : null
      const val = co ? matchEffort(effort, co.options) : null
      if (val != null && val !== '') {
        try {
          await rpc('session/set_config_option', { sessionId: entry.acpSessionId, configId: 'thought_level', value: val }, Math.min(15000, left()))
          effortApplied = true
          effortValue = val
        } catch (e) {
          console.error('[agent-selector] set_config_option(thought_level=' + val + ') 失败（跳过设档，不阻断）: ' + (e && e.message ? e.message : e))
        }
      } else {
        console.error('[agent-selector] configOptions 缺 thought_level 或档位无法匹配（effort=' + effort + '），跳过设档')
      }
    }

    // ── 模型：session 定型后、prompt 之前设 configId="model"（v0.2.3 修复 3）──
    // 与档位同构：失败/校验不通过都不阻断，只标注 modelApplied=false 让调用方看得见。
    // 校验顺序（缺一不可）：
    //   ① configOptions 里必须有 id==='model' 的项（否则服务端不认这个 configId）；
    //   ② value 必须在 availableModels[].modelId 白名单内（否则写进非法值，服务端行为未定义）。
    let modelApplied = false
    let modelValue = ''
    if (model && entry.acpSessionId) {
      const co = Array.isArray(cfgOptions) ? cfgOptions.find((c) => c && c.id === 'model') : null
      const allowed = Array.isArray(cfgModels) ? cfgModels.map((m) => (m && m.modelId) || '').filter(Boolean) : []
      if (!co) {
        console.error('[agent-selector] configOptions 缺 model 项，跳过设模型（model=' + model + '）')
      } else if (allowed.length && !allowed.includes(model)) {
        console.error('[agent-selector] model=' + model + ' 不在 availableModels 白名单内，跳过设模型（前 8 项：' + allowed.slice(0, 8).join(',') + '）')
      } else if (!allowed.length) {
        console.error('[agent-selector] 无法取得 availableModels 白名单，跳过设模型（model=' + model + '）')
      } else {
        try {
          await rpc('session/set_config_option', { sessionId: entry.acpSessionId, configId: 'model', value: model }, Math.min(15000, left()))
          modelApplied = true
          modelValue = model
        } catch (e) {
          console.error('[agent-selector] set_config_option(model=' + model + ') 失败（跳过设模型，不阻断）: ' + (e && e.message ? e.message : e))
        }
      }
    }

    // session/prompt：聚合 agent_message_chunk
    let text = ''
    // v0.2.2 修复：prompt 是主步骤，预算独立保底——此前 left() 被
    // connect/initialize/load/set_config_option 等前置步骤吃掉后只剩 1000ms
    // 下限，长 brief 必超时（实测撞过，LESSONS 同源条目）
    // v0.3.2（R3）：保底 120s→240s（长任务 120s 必超时）；并打印前置耗时构成，
    // 让"ACP 死于第几分钟"在日志可见——此前看门狗/超时被桥回退掩盖，用户只见"卡 15 分钟"。
    const preSpentMs = Date.now() - t0
    const promptBudget = Math.max(240000, left())
    console.error('[agent-selector] ACP prompt 启动：前置耗时 ' + Math.round(preSpentMs / 1000) +
      's，剩余死线 ' + Math.round(left() / 1000) + 's，prompt 预算 ' + Math.round(promptBudget / 1000) + 's' +
      (preSpentMs > (preSpentMs + left()) * 0.5 ? ' ⚠️前置已吃超 50% 总预算' : ''))
    const final = await rpc('session/prompt', {
      sessionId: entry.acpSessionId,
      prompt: [{ type: 'text', text: task }],
    }, promptBudget, (m) => {
      const u = m && m.params && m.params.update
      if (!u || typeof u !== 'object') return
      const kind = u.sessionUpdate
      const textOf = (c) => {
        if (typeof c === 'string') return c
        if (c && typeof c.text === 'string') return c.text
        if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('')
        return ''
      }
      if (kind === 'agent_message_chunk') {
        const t = textOf(u.content)
        text += t
        if (t && onUpdate) { try { onUpdate({ kind: 'message', text: t, ts: Date.now() }) } catch { /* onUpdate 不得影响主流 */ } }
        return
      }
      // v0.3.0 过程流面板：思考 / 工具调用 chunk 外抛（onUpdate 来自 runOnce 参数 o——
      // ⚠️ 勿直接引用 acpDispatch 的 opts：runOnce 作用域内无 opts，ReferenceError 会打断 prompt 流）
      if (!onUpdate) return
      try {
        if (kind === 'agent_thought_chunk') {
          const t = textOf(u.content)
          if (t) onUpdate({ kind: 'thought', text: t, ts: Date.now() })
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const label = '🔧 ' + [u.title || (u.toolCall && u.toolCall.title) || u.kind || u.toolCallId || 'tool', u.status || ''].filter(Boolean).join(' · ')
          const body = textOf(u.content)
          onUpdate({ kind: 'tool', text: body ? label + '\n' + clip0(body, 400) : label, ts: Date.now() })
        }
      } catch { /* onUpdate 不得影响主流 */ }
    })
    const stopReason = (final && final.result && final.result.stopReason) || ''
    if (stopReason === 'cancelled') throw new Error('ACP prompt 被取消（stopReason=cancelled）')
    // v0.3.2（R4）：pending 应答尾等待加 12s 硬上限——应答流长尾不得拖延结果返回
    await Promise.race([Promise.allSettled(pending), new Promise((res2) => setTimeout(res2, 12000))])
    if (!text.trim()) text = '[ACP 未返回 agent_message_chunk 文本] stopReason=' + (stopReason || '?')
    // ⚠️ 不在此 DELETE：连接放回池复用，同进程内多轮续聊才稳定。
    // 注：DELETE 本身已实测**不会**丢历史（见文件头六组对照），此处池化是为了复用连接而非保命。
    poolPut(key, entry)
    // 宿主重启标注：护栏①（hostChanged ⇒ 强制 session/new）生效时，在返回文本前加 ⚠ 标注，
    // 让"假续聊被拦截"在直接调用 acpDispatch 的输出里也可见（acp_sticky.mjs 验证过的行为）
    const hostWarn = hostChanged
      ? '⚠️宿主已重启（宿主指纹已变更，旧 acpSessionId 上下文已失效，本轮已强制开新会话）\n\n'
      : ''
    return {
      text: hostWarn + text.trim(),
      acpSessionId: entry.acpSessionId,
      durationMs: Date.now() - t0,
      endpoint: base,
      sessionMode,
      stopReason,
      reused: !!reused,
      // 自检信号（供调用方持久化/告警）
      hostToken: hostToken || '',   // 宿主指纹，下次调用回传以检测宿主重启
      hostChanged: !!hostChanged,   // 本次是否因宿主指纹变化而弃用旧会话
      sessionBlank,                 // false=上下文非空（确定）；true=未知；null=未走 load
      sessionReused,                // true=session/new 拿到的不是空白会话（上下文可能不干净）
      newTries,                     // session/new 尝试次数（>1=重试过）
      effortApplied,                // true=thought_level 档位设置成功
      effortValue,                  // 实际下发的档位值（服务端 options 里的原值）
      modelApplied,                 // true=configId="model" 设置成功
      modelValue,                   // 实际下发的模型 id（未设则为空串）
    }
  } finally {
    // v0.3.2（R4）：同上限——异常路径也不被应答长尾拖住
    await Promise.race([Promise.allSettled(pending), new Promise((res2) => setTimeout(res2, 12000))])
    if (entry) entry.busy = false // v0.3.2（R5）：释放并发闸
  }
}

export default acpDispatch
