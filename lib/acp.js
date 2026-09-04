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

/** 模块级连接池：key(DSH 会话) → { endpoint, connectionId, sessionToken, acpSessionId, created, headers, lastUsed } */
const POOL = new Map()

function clip0(s, n) { return String(s == null ? '' : s).slice(0, n) }

/**
 * 端点发现：扫 ~/.workbuddy/sessions/*.json，取 lastHeartbeat 最新的 url。
 * 覆盖优先级：opts.baseUrl > 环境变量 DSH_ACP_URL > sessions 目录扫描。
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
  cands[0].staleMs = Math.max(0, Date.now() - cands[0].lastHeartbeat)
  return cands[0]
}

/** SSE 流读取：解析 `data: {...}\n\n`，onMsg 返回 false 可提前收流 */
async function drainStream(res, onMsg, timeoutMs) {
  const body = res && res.body
  if (!body || typeof body.getReader !== 'function') throw new Error('ACP 响应无流式 body（不是 SSE？）')
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    try { const p = reader.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}) } catch { /* 忽略 */ }
  }
  const timer = setTimeout(stop, Math.max(1000, timeoutMs || 30000))
  try {
    for (;;) {
      let r
      try { r = await reader.read() } catch { break } // 流被 cancel / 连接断开
      if (r.done) break
      buf += dec.decode(r.value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data || data === '[DONE]') continue
        let msg = null
        try { msg = JSON.parse(data) } catch { continue }
        if (onMsg(msg) === false) { clearTimeout(timer); stop(); return }
      }
    }
  } finally {
    clearTimeout(timer)
    stop()
  }
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

function poolGet(key, url, acpSessionId) {
  const e = POOL.get(key)
  if (!e) return null
  if (e.endpoint !== url) { POOL.delete(key); return null }
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
 * ACP 委派主入口。
 * @param {object} opts { task, cwd, acpSessionId?, poolKey?, dmode?, timeoutMs?, baseUrl? }
 *   poolKey：连接池键（建议传 DSH 会话 id）——同一 poolKey 复用同一条 ACP 连接与会话，
 *   多轮历史才在。不传则退化为"按 acpSessionId/单例"复用。
 * @returns {Promise<{text, acpSessionId, durationMs, endpoint, sessionMode, stopReason, reused}>}
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

  const ep = discoverEndpoint(opts)

  // 连接失效（服务端 GC / 重启）时，丢弃旧连接重来一次；第二次仍失败才真正抛错
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const reused = poolGet(key, ep.url, wantedSessionId)
    try {
      return await runOnce(ep, reused, { task, cwd, wantedSessionId, key, left, t0 })
    } catch (e) {
      lastErr = e
      const msg = (e && e.message) || String(e)
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
  const { task, cwd, wantedSessionId, key, left, t0 } = o
  const base = ep.url
  let entry = reused
  let nextId = 1
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
      connectionId: grant.connectionId,
      sessionToken: grant.sessionToken || '',
      acpSessionId: wantedSessionId || '',
      created: false,
      initialized: false,
    }
    entry.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-codebuddy-request': '1',
      'acp-connection-id': entry.connectionId,
      'acp-session-token': entry.sessionToken,
    }
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
      await drainStream(res, () => {}, 5000).catch(() => {})
    } catch (e) {
      console.error('[agent-selector] ACP 反向调用应答失败 ' + method + ': ' + (e && e.message ? e.message : e))
    }
  }

  /** 一次 JSON-RPC：返回 id 匹配的最终响应；onNotify 收 notification */
  async function rpc(method, params, ms, onNotify) {
    const id = nextId++
    const budget = Math.max(1000, ms || 30000)
    const res = await post({ jsonrpc: '2.0', id, method, params }, budget)
    let final = null
    await drainStream(res, (m) => {
      if (!m || typeof m !== 'object') return
      if (m.id != null && m.method) { pending.push(respond(m)); return } // 服务端 → 客户端请求
      if (m.id === id) { final = m; return false }
      if (typeof onNotify === 'function') onNotify(m)
      return
    }, budget)
    if (!final) throw new Error('ACP ' + method + ' 超时未收到结果响应（' + budget + 'ms）')
    if (final.error) throw new Error('ACP ' + method + ' 错误 ' + final.error.code + ': ' + final.error.message)
    return final
  }

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
    let sessionMode = entry.acpSessionId ? 'load' : 'new'
    if (entry.acpSessionId) {
      const lr = await rpc('session/load', { sessionId: entry.acpSessionId, cwd, mcpServers: [] }, Math.min(60000, left())).catch((e) => ({ __err: e }))
      if (lr && lr.__err) {
        console.error('[agent-selector] ACP session/load 失败，降级 session/new: ' + lr.__err.message)
        entry.acpSessionId = ''
        sessionMode = 'new'
      }
    }
    if (!entry.acpSessionId) {
      const nr = await rpc('session/new', { cwd, mcpServers: [] }, Math.min(60000, left()))
      entry.acpSessionId = (nr && nr.result && nr.result.sessionId) || ''
      if (!entry.acpSessionId) throw new Error('ACP session/new 未返回 sessionId')
      entry.created = true
    }

    // session/prompt：聚合 agent_message_chunk
    let text = ''
    const final = await rpc('session/prompt', {
      sessionId: entry.acpSessionId,
      prompt: [{ type: 'text', text: task }],
    }, left(), (m) => {
      const u = m && m.params && m.params.update
      if (!u || u.sessionUpdate !== 'agent_message_chunk') return
      const c = u.content
      if (typeof c === 'string') text += c
      else if (c && typeof c.text === 'string') text += c.text
      else if (Array.isArray(c)) text += c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('')
    })
    const stopReason = (final && final.result && final.result.stopReason) || ''
    if (stopReason === 'cancelled') throw new Error('ACP prompt 被取消（stopReason=cancelled）')
    await Promise.allSettled(pending)
    if (!text.trim()) text = '[ACP 未返回 agent_message_chunk 文本] stopReason=' + (stopReason || '?')
    // ⚠️ 不在此 DELETE：连接放回池复用，同进程内多轮续聊才稳定。
    // 注：DELETE 本身已实测**不会**丢历史（见文件头六组对照），此处池化是为了复用连接而非保命。
    poolPut(key, entry)
    return {
      text: text.trim(),
      acpSessionId: entry.acpSessionId,
      durationMs: Date.now() - t0,
      endpoint: base,
      sessionMode,
      stopReason,
      reused: !!reused,
    }
  } finally {
    await Promise.allSettled(pending)
  }
}

export default acpDispatch
