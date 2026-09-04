/**
 * dsh-agent-selector — client half (v0.1.0)
 * 设置 →「🤖 智能体选择器」面板：
 *   - 委托目标卡片（codex / hy3 / claude-code 挂起）：状态灯 + 说明 + 单选默认
 *   - hy3 桥健康探活（probe）
 *   - 测试派发（真实发一个小任务验证通道）
 * 零 JSX，手写 React.createElement；全 try-catch 不崩宿主。
 */

window.__ModuleLoader__.load({ id: "dsh-agent-selector", factory: (require) => {

  var React = require("react")

  var API = "/__agent-selector/api"
  function api(method, args) {
    return fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ method: method, args: args || {} }),
    }).then(function (r) { return r.json() })
  }

  var inject = ["slots"]

  var S = {
    wrap: { background: "#0d1117", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 10, padding: 16, marginBottom: 14, fontFamily: "system-ui,-apple-system,sans-serif" },
    h: { margin: "0 0 4px", fontSize: 15, fontWeight: 700 },
    sub: { margin: "0 0 12px", fontSize: 12, color: "#8b949e", lineHeight: 1.5 },
    card: { border: "1px solid #30363d", background: "#161b22", borderRadius: 8, padding: "10px 12px", marginBottom: 8 },
    row: { display: "flex", alignItems: "flex-start", gap: 10 },
    dot: function (color) { return { width: 9, height: 9, borderRadius: 9, background: color, flexShrink: 0, marginTop: 5 } },
    name: { fontSize: 13, fontWeight: 600 },
    desc: { fontSize: 12, color: "#8b949e", lineHeight: 1.5, marginTop: 2 },
    radio: { accentColor: "#238636", marginTop: 4, cursor: "pointer" },
    btn: { background: "#238636", color: "#fff", border: 0, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
    btn2: { background: "#21262d", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer" },
    out: { marginTop: 10, background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, padding: 10, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto", color: "#c9d1d9" },
    err: { color: "#f85149" },
    ok: { color: "#3fb950" },
  }

  function AgentCard(p) {
    var a = p.agent
    var color = a.suspended ? "#d29922" : (a.available ? "#3fb950" : "#f85149")
    return React.createElement("div", { style: S.card },
      React.createElement("div", { style: S.row },
        React.createElement("label", { style: { display: "flex", gap: 10, flex: 1, cursor: a.pickable ? "pointer" : "not-allowed" } },
          React.createElement("input", {
            type: "radio", name: "agssel-target", style: S.radio, checked: p.checked, disabled: !a.pickable,
            onChange: function () { p.onPick(a.id) },
          }),
          React.createElement("div", { style: { flex: 1 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              React.createElement("span", { style: S.dot(color) }),
              React.createElement("span", { style: S.name }, a.title),
              a.tag ? React.createElement("span", { style: { fontSize: 11, color: "#d29922", border: "1px solid #d29922", borderRadius: 10, padding: "0 8px" } }, a.tag) : null,
              p.checked ? React.createElement("span", { style: { fontSize: 11, color: "#3fb950" } }, "✓ 默认") : null,
            ),
            React.createElement("div", { style: S.desc }, a.desc),
          ),
        ),
      ),
    )
  }

  function SelectorPanel(props) {
    var sessionId = (props && typeof props.sessionId === "string") ? props.sessionId : ""
    var st = React.useState({ loading: true, probe: null, cfg: null, testing: false, probing: false, out: "", msg: "" })
    var d = st[0], set = st[1]
    var refresh = React.useCallback(function () {
      api("agents.list", { sessionId: sessionId }).then(function (j) {
        if (j && j.ok) set(function (p) { return { ...p, loading: false, probe: j.result, cfg: j.result.config || {} } })
        else set(function (p) { return { ...p, loading: false, msg: (j && j.error) || "agents.list 失败" } })
      }).catch(function (e) { set(function (p) { return { ...p, loading: false, msg: String(e) } }) })
    }, [])
    React.useEffect(function () { refresh() }, [refresh])

    function pick(id) {
      api("config.set", { config: { defaultTarget: id } }).then(function (j) {
        if (j && j.ok) set(function (p) { return { ...p, cfg: j.result, msg: "默认委托目标已保存：" + id } })
        else set(function (p) { return { ...p, msg: (j && j.error) || "保存失败" } })
      }).catch(function (e) { set(function (p) { return { ...p, msg: String(e) } }) })
    }
    function probeHy3() {
      set(function (p) { return { ...p, probing: true, out: "" } })
      api("hy3.probe").then(function (j) {
        var r = (j && j.ok && j.result) || { ok: false, reason: (j && j.error) || "fail" }
        set(function (p) {
          return { ...p, probing: false, out: (r.ok ? "✅ hy3 桥健康\n" : "❌ hy3 桥异常\n") + JSON.stringify(r, null, 2) }
        })
      }).catch(function (e) { set(function (p) { return { ...p, probing: false, out: "probe 失败: " + String(e) } }) })
    }
    function test(t) {
      set(function (p) { return { ...p, testing: true, out: "⏳ 正在派发测试任务到 " + t + " …（hy3 为异步分钟级，请稍候）" } })
      api("dispatch.test", { target: t }).then(function (j) {
        set(function (p) {
          return { ...p, testing: false, out: (j && j.ok) ? ("✅ 通道可用\n\n" + j.result) : ("❌ " + ((j && j.error) || "fail")) }
        })
      }).catch(function (e) { set(function (p) { return { ...p, testing: false, out: "❌ " + String(e) } }) })
    }

    var pr = d.probe
    var cards = []
    if (pr) {
      cards.push({ id: "codex", title: "Codex", available: pr.codex.available, pickable: pr.codex.available, tag: pr.codex.model ? "模型 " + pr.codex.model : "", desc: pr.codex.available ? "ChatGPT 原生额度 · CLI 同步派发 · 结果回对话" : "未找到 codex.js" })
      cards.push({ id: "hy3", title: "WorkBuddy · hy3", available: pr.hy3.available, pickable: pr.hy3.available, tag: "活动价", desc: pr.hy3.available ? "走 WorkBuddy 订阅额度 · 异步分钟级（≤30s 拾起 + 执行）· automation 桥（逆向依赖，升级可能碎，测试按钮可探活）" : "未找到 WorkBuddy 数据库" })
      cards.push({ id: "claude-code", title: "Claude Code", available: pr["claude-code"].available, suspended: true, pickable: false, tag: "挂起", desc: pr["claude-code"].note || "" })
    }

    return React.createElement("div", { style: S.wrap },
      React.createElement("h3", { style: S.h }, "🤖 智能体选择器"),
      React.createElement("p", { style: S.sub },
        "勾选默认委托目标后，对话里说「用默认智能体干 X」或让模型调 agent_dispatch 工具即可把任务派给对应智能体，结果流回对话。也可在对话里直接点名：codex / hy3。"),
      d.loading ? React.createElement("div", { style: S.desc }, "加载中…") : null,
      d.msg ? React.createElement("div", { style: { ...S.desc, color: "#f85149" } }, d.msg) : null,
      cards.map(function (a) {
        return React.createElement(AgentCard, { key: a.id, agent: a, checked: (d.cfg && d.cfg.defaultTarget) === a.id, onPick: pick })
      }),
      React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" } },
        React.createElement("button", { style: S.btn2, disabled: d.probing, onClick: probeHy3 }, d.probing ? "探活中…" : "🩺 hy3 桥探活"),
        React.createElement("button", { style: S.btn2, disabled: d.testing, onClick: function () { test("codex") } }, d.testing ? "…" : "⚡ 测试 Codex"),
        React.createElement("button", { style: S.btn2, disabled: d.testing, onClick: function () { test("hy3") } }, "⚡ 测试 hy3"),
      ),
      d.out ? React.createElement("div", { style: S.out }, d.out) : null,
    )
  }

  // ---------- Composer 下拉：模型选择器旁的智能体选择器（两步：智能体 → 模型） ----------

  var TARGET_META = [
    { id: "auto", title: "跟随面板默认", desc: "", pickable: true },
    { id: "codex", title: "Codex", desc: "ChatGPT 原生额度", modelKey: "codexModel" },
    { id: "hy3", title: "WorkBuddy · hy3", desc: "活动价 · 异步分钟级", modelKey: "hy3Model" },
    { id: "wbmodel", title: "WorkBuddy · 自定义模型", desc: "你的 API key · models.json 直连", modelKey: "wbCustomModel" },
    { id: "claude-code", title: "Claude Code", desc: "DeepSeek 壳 · 槽位 pin 已修复", modelKey: "claudeModel" },
  ]

  function ComposerAgentSelector(props) {
    var st = React.useState({ open: false, step: "agents", modelsFor: "", target: "auto", cfg: {}, avail: {}, modeToggling: false })
    var d = st[0], set = st[1]
    var rootRef = React.useRef(null)
    var sessionId = (props && typeof props.sessionId === 'string') ? props.sessionId : ''

    var load = React.useCallback(function () {
      api("config.get", { sessionId: sessionId }).then(function (j) {
        if (j && j.ok) set(function (p) { return { ...p, cfg: j.result || {}, target: (j.result && j.result.defaultTarget) || "auto" } })
      }).catch(function () {})
      api("agents.list", { sessionId: sessionId }).then(function (j) {
        if (j && j.ok) set(function (p) {
          var r = j.result || {}
          return { ...p, avail: {
            codex: !!(r.codex && r.codex.available), hy3: !!(r.hy3 && r.hy3.available),
            wbmodel: !!(r.wbmodel && r.wbmodel.available),
            'claude-code': !!(r['claude-code'] && r['claude-code'].available),
            models: {
              codex: (r.codex && r.codex.models) || [],
              hy3: (r.hy3 && r.hy3.models) || [],
              wbmodel: (r.wbmodel && r.wbmodel.models) || [],
              'claude-code': (r['claude-code'] && r['claude-code'].models) || [],
            },
          } }
        })
      }).catch(function () {})
    }, [])
    React.useEffect(function () { load() }, [load])

    React.useEffect(function () {
      if (!d.open) return
      function onDoc(e) {
        try { if (rootRef.current && !rootRef.current.contains(e.target)) set(function (p) { return { ...p, open: false } }) } catch (err) {}
      }
      document.addEventListener("mousedown", onDoc)
      return function () { document.removeEventListener("mousedown", onDoc) }
    }, [d.open])

    function save(cfgPatch) {
      api("config.set", { sessionId: sessionId, config: cfgPatch }).then(function (j) {
        if (j && j.ok) set(function (p) { return { ...p, cfg: j.result || p.cfg, target: (j.result && j.result.defaultTarget) || p.target, open: false, step: "agents" } })
      }).catch(function () {})
    }
    function pickAgent(id) {
      if (id === "auto") { save({ defaultTarget: "auto" }); return }
      set(function (p) { return { ...p, step: "models", modelsFor: id } })
    }
    function pickModel(m) {
      var meta = null
      for (var i = 0; i < TARGET_META.length; i++) { if (TARGET_META[i].id === d.modelsFor) meta = TARGET_META[i] }
      if (!meta) return
      var patch = { defaultTarget: meta.id }
      patch[meta.modelKey] = m
      save(patch)
    }

    function toggleMode() {
      var cur = (d.cfg && d.cfg.delegateMode) | 0
      var next = (cur + 1) % 3
      set(function (p) { return { ...p, modeToggling: true } })
      api("config.set", { sessionId: sessionId, config: { delegateMode: next } }).then(function (j) {
        if (!(j && j.ok)) { set(function (p) { return { ...p, modeToggling: false, open: false } }); return }
        set(function (p) { return { ...p, cfg: j.result || p.cfg, modeToggling: false, open: false } })
        api("mode.announce", { sessionId: sessionId, mode: next }).then(function (a) {
          if (!(a && a.ok)) {
            try { alert("开关已保存，但向当前会话宣告失败：" + ((a && a.error) || "unknown") + "\n请在会话中重新拨动一次开关。") } catch (e) {}
          }
        }).catch(function () {})
      }).catch(function () {})
    }

    function comboLabel() {
      var c = d.cfg || {}
      var t = c.defaultTarget || "auto"
      if (t === "auto") return "跟随面板默认"
      if (t === "codex") return "Codex · " + (c.codexModel || "默认")
      if (t === "hy3") return "hy3 · " + (c.hy3Model || "hy3")
      if (t === "wbmodel") return "WB · " + (c.wbCustomModel || "未选模型")
      if (t === "claude-code") return "Claude · " + (c.claudeModel || "deepseek-v4-pro")
      return t
    }
    var current = comboLabel()

    var menuTitle = d.step === "models"
      ? ({ codex: "Codex · 选择模型", hy3: "WorkBuddy 内置 · 选择模型", wbmodel: "自定义模型 · 选择" }[d.modelsFor] || "选择模型")
      : "委派目标（agent_dispatch 默认）"

    var body = []
    if (d.step === "agents") {
      body.push(TARGET_META.map(function (it) {
        var ok = it.id === "auto" || d.avail[it.id] !== false
        var active = (d.cfg && d.cfg.defaultTarget) === it.id
        var cur = ""
        if (it.id === "codex" && active) cur = d.cfg.codexModel || ""
        if (it.id === "hy3" && active) cur = d.cfg.hy3Model || ""
        if (it.id === "wbmodel" && active) cur = d.cfg.wbCustomModel || ""
        return React.createElement("div", {
          key: it.id,
          onClick: function () { if (ok) pickAgent(it.id) },
          style: {
            display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 7,
            cursor: ok ? "pointer" : "not-allowed", opacity: ok ? 1 : 0.45,
            background: active ? "#1c2128" : "transparent",
          },
          onMouseEnter: function (e) { if (ok) e.currentTarget.style.background = "#1c2128" },
          onMouseLeave: function (e) { e.currentTarget.style.background = active ? "#1c2128" : "transparent" },
        },
          React.createElement("span", { style: { width: 16, textAlign: "center", color: "#3fb950", fontSize: 12 } }, active ? "✓" : ""),
          React.createElement("span", { style: { flex: 1 } },
            React.createElement("div", { style: { fontSize: 13, color: "#e6edf3" } }, it.title + (cur ? " · " + cur : "")),
            it.desc ? React.createElement("div", { style: { fontSize: 11, color: "#8b949e" } }, it.desc) : null,
          ),
          it.id !== "auto" ? React.createElement("span", { style: { fontSize: 10, color: "#8b949e" } }, "选模型 ▸") : null,
        )
      }))
    } else {
      var rawModels = (d.avail.models && d.avail.models[d.modelsFor]) || []
      var modelKey = (TARGET_META.filter(function (m) { return m.id === d.modelsFor })[0] || {}).modelKey
      var currentModel = (d.cfg && modelKey && d.cfg[modelKey]) || ""
      // 统一对象渲染：{id, label|name, vendor?}（字符串自动包装）
      var models = rawModels.map(function (m) {
        return typeof m === "string" ? { id: m, label: m, sub: "" } : { id: m.id, label: m.label || m.name || m.id, sub: m.vendor || "" }
      })
      body.push(models.map(function (m) {
        var active = currentModel === m.id
        return React.createElement("div", {
          key: m.id, onClick: function () { pickModel(m.id) },
          style: {
            display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 7, cursor: "pointer",
            background: active ? "#1c2128" : "transparent",
          },
          onMouseEnter: function (e) { e.currentTarget.style.background = "#1c2128" },
          onMouseLeave: function (e) { e.currentTarget.style.background = active ? "#1c2128" : "transparent" },
        },
          React.createElement("span", { style: { width: 16, textAlign: "center", color: "#3fb950", fontSize: 12 } }, active ? "✓" : ""),
          React.createElement("span", { style: { flex: 1 } },
            React.createElement("div", { style: { fontSize: 13, color: "#e6edf3" } }, m.label),
            m.sub ? React.createElement("div", { style: { fontSize: 11, color: "#8b949e" } }, m.sub + " · " + m.id) : null,
          ),
        )
      }))
      body.push(React.createElement("div", {
        key: "back", onClick: function () { set(function (p) { return { ...p, step: "agents" } }) },
        style: { fontSize: 11, color: "#58a6ff", padding: "8px 8px 2px", cursor: "pointer" },
      }, "← 返回智能体列表"))
    }

    return React.createElement("div", { ref: rootRef, style: { position: "relative", display: "inline-flex" } },
      React.createElement("button", {
        title: "智能体选择器：agent_dispatch 委派的目标+模型组合",
        onClick: function () { set(function (p) { return { ...p, open: !p.open, step: "agents" } }); load() },
        style: {
          background: "transparent", border: 0, color: d.open ? "#e6edf3" : "var(--dsh-fg-muted, #8b949e)",
          fontSize: 13, cursor: "pointer", padding: "3px 8px", borderRadius: 6,
          display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
          lineHeight: "20px",
        },
        onMouseEnter: function (e) { e.currentTarget.style.color = "#e6edf3" },
        onMouseLeave: function (e) { if (!d.open) e.currentTarget.style.color = "var(--dsh-fg-muted, #8b949e)" },
      },
        "🤖 " + current,
        React.createElement("svg", {
          width: 12, height: 12, viewBox: "0 0 16 16", fill: "none",
          style: { opacity: 0.85, flexShrink: 0 },
        }, React.createElement("path", {
          d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: 1.8,
          strokeLinecap: "round", strokeLinejoin: "round",
        })),
      ),
      ((d.cfg && d.cfg.delegateMode) | 0) > 0 ? React.createElement("span", {
        title: ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "全托管：所有消息（含讨论）一律交给所选智能体" : "委派模式：任务类指令自动交给所选智能体",
        style: {
          marginLeft: 4, fontSize: 10, fontWeight: 700,
          color: ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "#d29922" : "#3fb950",
          border: "1px solid " + (((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "#d29922" : "#238636"),
          borderRadius: 8, padding: "1px 6px",
          display: "inline-flex", alignItems: "center", gap: 3,
        },
      }, ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "⚡ 全托管" : "⚡ 委派中") : null,
      d.open ? React.createElement("div", {
        style: {
          position: "absolute", bottom: "calc(100% + 8px)", right: 0, zIndex: 9999,
          minWidth: 260, maxHeight: 420, overflowY: "auto", background: "#161b22", border: "1px solid #30363d", borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)", padding: 6, fontFamily: "system-ui,-apple-system,sans-serif",
        },
      },
        React.createElement("div", { style: { fontSize: 11, color: "#8b949e", padding: "4px 8px 6px" } }, menuTitle),
        React.createElement("div", {
          onClick: function () { if (!d.modeToggling) toggleMode() },
          style: {
            display: "flex", alignItems: "center", gap: 8, padding: "8px", marginBottom: 4,
            borderRadius: 7, cursor: "pointer",
            background: ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "#2d2410" : ((d.cfg && d.cfg.delegateMode) ? "#12261e" : "#161b22"),
            border: ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "#d29922" : ((d.cfg && d.cfg.delegateMode) ? "1px solid #238636" : "1px solid #30363d"),
          },
          title: "开启后：本会话的任务类指令自动交给所选智能体执行，无需每次口头指定",
        },
          React.createElement("span", { style: { fontSize: 13 } }, "⚡"),
          React.createElement("span", { style: { flex: 1 } },
            React.createElement("div", { style: { fontSize: 13, color: "#e6edf3" } },
              "委派模式", React.createElement("span", { style: { fontSize: 11, color: "#8b949e", marginLeft: 6 } },
                (d.cfg && d.cfg.delegateMode) > 1 ? "FULL · 全托管（所有消息一律委派）" : ((d.cfg && d.cfg.delegateMode) ? "ON · 任务类自动委派" : "OFF")),
            ),
            React.createElement("div", { style: { fontSize: 11, color: "#8b949e", marginTop: 2 } },
              "开启后无需在指令前点名智能体；寒暄提问仍由当前对话直接回答"),
          ),
          React.createElement("span", { style: { fontSize: 12, color: ((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "#d29922" : ((d.cfg && d.cfg.delegateMode) ? "#3fb950" : "#8b949e") } },
            d.modeToggling ? "…" : (((d.cfg && d.cfg.delegateMode) | 0) >= 2 ? "FULL" : ((d.cfg && d.cfg.delegateMode) ? "ON" : "OFF"))),
        ),
        body,
      ) : null,
    )
  }

  function apply(ctx) {
    try {
      var slots = ctx.slots
      var panelDone = false
      function tryInject() {
        try {
          if (panelDone) return
          slots.inject("settings.section", function () {
            panelDone = true
            return slots.register(
              { name: "settings.section", id: "agent-selector", order: 15, label: "🤖 智能体选择器" },
              function (props) { return React.createElement(SelectorPanel, props) }
            )
          })
        } catch (e) { /* 静默重试 */ }
      }
      setTimeout(tryInject, 1500)
      setInterval(tryInject, 8000)

      // Composer 工具行（模型选择器旁）的智能体下拉
      var composerDone = false
      function tryInjectComposer() {
        try {
          if (composerDone) return
          slots.inject("conversation.input.right", function () {
            composerDone = true
            return slots.register(
              { name: "conversation.input.right", id: "agent-selector-composer", order: 1, label: "智能体选择器" },
              function (props) { return React.createElement(ComposerAgentSelector, props) }
            )
          })
        } catch (e) { /* 静默重试 */ }
      }
      setTimeout(tryInjectComposer, 2000)
      setInterval(tryInjectComposer, 8000)
    } catch (e) { /* I8 */ }
  }

  return { inject: inject, apply: apply }
}})
