# -*- coding: utf-8 -*-
r"""wb_bridge.py — WorkBuddy automation bridge (builtin-model channel engine for dsh-agent-selector)

Mechanism (field-verified 2026-09-04; see repository README "机制与风险"):
  enqueue: INSERT a one-shot row into WorkBuddy's automations table ->
  WorkBuddy LocalAutomationScheduler (30s tick, reads DB not memory cache) picks
  it up -> the selected builtin model drives a full WorkBuddy agent to execute
  -> read automation_runs + result file -> cleanup (delete task row + run row).

Hard-won invariants:
  - next_run_at (INTEGER ms) is the scheduler's ONLY scan key; scheduled_at is
    input-only. Missing it = never picked up.
  - once-row template mirrors a real on-device sample: rrule='', permission_mode
    ='fullAccess', owner_* copied from the newest live row (never hardcoded).
  - All writes are BEGIN IMMEDIATE short transactions; never touch pre-existing rows.
  - IO is fully file-based (--in/--out, UTF-8): Windows pipes get mangled to the
    system codepage by some hosts — pipes carry paths only, data travels in files.

Usage:
  wb_bridge.py probe                                # health check (stdout JSON)
  wb_bridge.py models                               # aggregate builtin model list
  wb_bridge.py enqueue --in <in.json> --out <out.json>
      in.json: {"model":"hy3","prompt":"...","cwd":"D:\\dir","timeoutMs":600000}
    out.json: {"ok":true,"text":"...","durationMs":123,"conversationId":"..."} or
              {"ok":false,"reason":"..."}
  wb_bridge.py call --in <in.json> --out <out.json>  # direct channel to a
      models.json custom model (OpenAI-compatible endpoint, user's own key)
"""
import sqlite3
import json
import os
import sys
import time
import datetime
import shutil  # v0.1.9e: task_dir 读后清理
import urllib.request
import urllib.error

DB = os.path.expanduser(r"~\.workbuddy\workbuddy.db")
MODELS_JSON = os.path.expanduser(r"~\.workbuddy\models.json")
POLL_INTERVAL_S = 5
PICKUP_GRACE_S = 90  # next_run_at 到期后仍无人拾起的额外宽限

def emit(obj, out_path=None):
    text = json.dumps(obj, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()

def now_ms():
    return int(time.time() * 1000)

def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    return db

# 桌面端内置模型的显示名映射（对照 WorkBuddy 桌面 /model 面板，2026-09-04；新增模型若不在表里则直接显示 id）
WB_BUILTIN_LABELS = {
    "hy4-preview": "Hy4 preview（限时免费）",
    "hy3": "Hy3（限时免费）",
    "glm-5.3": "GLM-5.3（0.79x）",
    "glm-5.3-flash": "GLM-5.3-Flash（0.06x）",
    "glm-5.2": "GLM-5.2（0.79x 夜间折扣）",
    "glm-5.1": "GLM-5.1",
    "auto": "自动",
}

def list_models():
    """聚合实际可用的内置 modelId：sessions.model 全集 ∪ automations.model_id 全集，
    过滤 custom-local: 前缀（那些走 wbmodel 直连通道）与已知无效格式（大小写错误的旧记录）。"""
    try:
        db = connect()
        ids = set()
        for r in db.execute("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL AND model != ''"):
            ids.add(str(r[0]).strip())
        for r in db.execute("SELECT DISTINCT model_id FROM automations WHERE model_id IS NOT NULL AND model_id != '' AND deleted_at IS NULL"):
            ids.add(str(r[0]).strip())
        builtin = []
        for mid in sorted(ids):
            if not mid or mid.startswith("custom-local:"):
                continue
            if mid != "auto" and mid != mid.lower():  # 大小写错误的旧记录（如 GLM5-2）排除
                continue
            builtin.append({"id": mid, "label": WB_BUILTIN_LABELS.get(mid, mid)})
        # 核心兜底：确保桌面端在售模型至少可见（即使本机还没用过）
        for mid, label in WB_BUILTIN_LABELS.items():
            if mid != "auto" and not any(b["id"] == mid for b in builtin):
                builtin.append({"id": mid, "label": label + "（未用过）"})
        builtin.sort(key=lambda b: (b["id"] != "hy3", b["id"] != "hy4-preview", b["id"]))
        emit({"ok": True, "models": builtin})
    except Exception as e:
        emit({"ok": False, "reason": repr(e)})

def probe():
    try:
        db = connect()
        cols = [c[1] for c in db.execute("PRAGMA table_info(automations)").fetchall()]
        need = ["id", "name", "prompt", "status", "schedule_type", "next_run_at",
                "rrule", "scheduled_at", "model_id", "owner_user_id", "permission_mode"]
        missing = [c for c in need if c not in cols]
        runs_cols = [c[1] for c in db.execute("PRAGMA table_info(automation_runs)").fetchall()]
        n_active = db.execute(
            "SELECT COUNT(*) FROM automations WHERE deleted_at IS NULL").fetchone()[0]
        owner = db.execute(
            "SELECT owner_user_id FROM automations WHERE owner_user_id IS NOT NULL "
            "AND owner_user_id != '' ORDER BY rowid DESC LIMIT 1").fetchone()
        models = [r[0] for r in db.execute(
            "SELECT DISTINCT model_id FROM automations WHERE model_id IS NOT NULL "
            "AND deleted_at IS NULL").fetchall()]
        emit({"ok": not missing,
              "reason": ("missing columns: %s" % missing) if missing else "schema ok",
              "activeRows": n_active,
              "ownerUserId": owner[0] if owner else None,
              "modelsInUse": models,
              "hasRunsTable": "thread_id" in runs_cols})
    except Exception as e:
        emit({"ok": False, "reason": repr(e)})

def enqueue(payload, out_path=None):
    model = payload.get("model") or "hy3"
    prompt = payload.get("prompt") or ""
    cwd = payload.get("cwd") or os.getcwd()
    timeout_ms = int(payload.get("timeoutMs") or 600000)
    if not prompt.strip():
        emit({"ok": False, "reason": "empty prompt"}, out_path); return
    db = None
    try:
        db = connect()
        owner = db.execute(
            "SELECT owner_user_id FROM automations WHERE owner_user_id IS NOT NULL "
            "AND owner_user_id != '' ORDER BY rowid DESC LIMIT 1").fetchone()
        owner_uid = owner[0] if owner else None
        if not owner_uid:
            emit({"ok": False, "reason": "no owner_user_id found in automations"}, out_path); return

        ts = now_ms()
        aid = "automation-%d" % ts
        task_dir = os.path.join(os.path.expanduser(r"~\.dsh\agent-selector\tasks"), "wb-%d" % ts)  # v0.1.9d: out of user workspace
        os.makedirs(task_dir, exist_ok=True)
        out_path_task = os.path.join(task_dir, "result.md")
        wrapped = (
            "【委托任务】请完成以下任务：\n\n" + prompt +
            "\n\n【输出要求】把最终成果完整写入文件 " + out_path_task +
            "（UTF-8 文本），写完即结束，不要做任何其他操作。\n" +
            "【记忆协作】若本轮有值得长期记住的发现/约束/结论（项目事实、踩坑、用户拍板），\n" +
            "请在 " + out_path_task + " 的末尾追加一段「## 记忆更新建议」，每条一行（- 开头）。\n" +
            '若任务本身缺少关键信息无法执行，则在 ' + out_path_task + ' 的开头第一行写 "NEEDS-CLARIFICATION: <缺什么>"，并简述需要澄清的内容。'
        )
        nr = ts + 5000  # next_run_at：5 秒后到期（调度器唯一扫描键，INTEGER ms）
        # v0.1.9e: valid_until = now + 2h，ISO 8601 UTC（格式对齐 scheduled_at 的
        # "%Y-%m-%dT%H:%M:%SZ"）。这是幽灵任务的第二道防线：桥进程被强杀/kill、
        # cleanup 没跑到时，残留行自身已过期，调度器或后续清理逻辑能识别它，
        # 不会在 WorkBuddy 下次启动时被当作有效 once 任务执行。
        # 窗口取 2h（远大于 enqueue 最长 600s+120s 的等待窗口），不影响正常任务。
        valid_until_iso = (datetime.datetime.now(datetime.timezone.utc)
                           + datetime.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        vals = {
            "id": aid, "name": "DSH委派-%d" % ts,
            "prompt": wrapped, "status": "ACTIVE", "schedule_type": "once",
            "next_run_at": nr, "last_run_at": None,
            "cwds": json.dumps([cwd]), "rrule": "",
            "scheduled_at": datetime.datetime.now(datetime.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "valid_from": None, "valid_until": valid_until_iso, "model_id": model,
            "model_is_thinking": 0, "push_to_wechat": 0,
            "owner_user_id": owner_uid, "owner_status": "confirmed",
            "owner_source": "created", "expert_id": None, "expert_marketplace": None,
            "connector_ids_json": "[]", "created_at": ts, "updated_at": ts,
            "deleted_at": None, "skills_json": "[]",
            "permission_mode": "fullAccess", "push_to_wecom_bot": 0,
            "wecom_bot_source": None,
        }
        cols = list(vals.keys())
        sql = "INSERT INTO automations (%s) VALUES (%s)" % (
            ",".join(cols), ",".join("?" * len(cols)))
        db.execute("BEGIN IMMEDIATE")
        db.execute(sql, [vals[c] for c in cols])
        db.execute("COMMIT")
        back = db.execute("SELECT id FROM automations WHERE id=?", (aid,)).fetchone()
        if not back:
            emit({"ok": False, "reason": "INSERT vanished (readback failed)"}, out_path); return
        # v0.1.9d: skeleton first — host reads aid from here to cancel ghost rows on abort/timeout
        emit({"ok": False, "reason": "running", "aid": aid}, out_path)

        t0 = time.time()
        deadline = t0 + timeout_ms / 1000.0
        done = None
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_S)
            if os.path.exists(out_path_task) and os.path.getsize(out_path_task) > 0:
                run = db.execute(
                    "SELECT runs_json, thread_title, metadata_json FROM automation_runs "
                    "WHERE automation_id=?", (aid,)).fetchone()
                rtext = open(out_path_task, encoding="utf-8").read().strip()
                done = {"text": rtext,
                        "needsClarification": rtext.startswith("NEEDS-CLARIFICATION:"),
                        "run": dict(run) if run else None}
                break
            run = db.execute(
                "SELECT result_success, thread_title, runs_json, metadata_json "
                "FROM automation_runs WHERE automation_id=?", (aid,)).fetchone()
            if run and run["result_success"] == 1:
                text = ""
                if os.path.exists(out_path_task):
                    try:
                        text = open(out_path_task, encoding="utf-8").read().strip()
                    except Exception:
                        pass
                if not text and run["thread_title"]:
                    text = run["thread_title"]
                done = {"text": text,
                        "needsClarification": text.startswith("NEEDS-CLARIFICATION:"),
                        "run": dict(run)}
                break
        if done is None:
            picked = db.execute(
                "SELECT COUNT(*) FROM automation_runs WHERE automation_id=?",
                (aid,)).fetchone()[0]
            reason = "timeout after %ds (runs=%d)" % (int(time.time() - t0), picked)
            cleanup(db, aid)
            emit({"ok": False, "reason": reason}, out_path); return

        run = done.get("run") or {}
        conv = ""
        try:
            meta = json.loads(run.get("metadata_json") or "{}")
            conv = meta.get("conversationId") or ""
        except Exception:
            pass
        # v0.1.9e: 结果文本已在 done["text"] 里（含 needsClarification 分支），
        # 回收 task_dir，防止 ~/.dsh/agent-selector/tasks/ 无限堆积。
        # 超时分支（done is None，上面已 return）刻意不删——残留的 result.md
        # 可能含部分产出，留给用户排查。
        shutil.rmtree(task_dir, ignore_errors=True)
        cleanup(db, aid)
        emit({"ok": True, "text": done["text"] or "(agent 未产出文本)",
              "durationMs": int((time.time() - t0) * 1000),
              "conversationId": conv}, out_path)
    except Exception as e:
        emit({"ok": False, "reason": repr(e)}, out_path)

def cleanup(db, aid):
    try:
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM automation_runs WHERE automation_id=?", (aid,))
        db.execute("DELETE FROM automations WHERE id=?", (aid,))
        db.execute("COMMIT")
    except Exception:
        try:
            db.execute("ROLLBACK")
        except Exception:
            pass

def call_custom(payload, out_path):
    """直连 ~/.workbuddy/models.json 里的自定义模型（OpenAI 兼容端点，用户自己的 key）。
    automation 桥只认内置清单（moa-review 实测自定义模型静默无产出），故自定义模型走此直连通道。"""
    model = payload.get("model") or ""
    prompt = payload.get("prompt") or ""
    try:
        cfgs = json.load(open(MODELS_JSON, encoding="utf-8"))
    except Exception as e:
        emit({"ok": False, "reason": "cannot read models.json: %r" % e}, out_path); return
    cfg = None
    for m in (cfgs if isinstance(cfgs, list) else []):
        if m.get("id") == model:
            cfg = m; break
    if not cfg:
        emit({"ok": False, "reason": "model not in models.json: %s (available: %s)"
              % (model, ", ".join(m.get("id", "?") for m in (cfgs if isinstance(cfgs, list) else [])))}, out_path); return
    url = cfg.get("url") or ""
    key = cfg.get("apiKey") or ""
    if not url:
        emit({"ok": False, "reason": "model %s has no url" % model}, out_path); return
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            detail = "(no body)"
        emit({"ok": False, "reason": "HTTP %d from %s: %s" % (e.code, model, detail)}, out_path); return
    except Exception as e:
        emit({"ok": False, "reason": repr(e)}, out_path); return
    text = ""
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except Exception:
        text = json.dumps(data, ensure_ascii=False)[:2000]
    if "<think>" in text:  # moa-review 同款：剥思维链
        text = text.split("</think>", 1)[-1].strip()
    emit({"ok": True, "text": text.strip(), "model_used": data.get("model") or model,
          "durationMs": int((time.time() - t0) * 1000)}, out_path)

def parse_args(argv):
    vals = {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--in", "--out") and i + 1 < len(argv):
            vals[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return vals

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) < 2:
        emit({"ok": False, "reason": "usage: probe | enqueue --in <path> --out <path>"}); return
    cmd = sys.argv[1]
    if cmd == "probe":
        probe(); return
    if cmd == "cancel":
        flags = parse_args(sys.argv[2:])
        aidc = flags.get("id")
        if not aidc:
            emit({"ok": False, "reason": "cancel needs --id <automation-id>"}); return
        try:
            dbc = connect()
            cleanup(dbc, aidc)
            emit({"ok": True, "cancelled": aidc})
        except Exception as e:
            emit({"ok": False, "reason": repr(e)})
        return
    if cmd == "models":
        list_models(); return
    if cmd == "call":
        flags = parse_args(sys.argv[2:])
        in_path = flags.get("in")
        out_path = flags.get("out")
        try:
            if not in_path or not os.path.exists(in_path):
                emit({"ok": False, "reason": "missing --in file"}, out_path); return
            with open(in_path, encoding="utf-8") as f:
                payload = json.load(f)
        except Exception as e:
            emit({"ok": False, "reason": "bad --in json: %r" % e}, out_path); return
        call_custom(payload, out_path); return
    if cmd == "enqueue":
        flags = parse_args(sys.argv[2:])
        in_path = flags.get("in")
        out_path = flags.get("out")
        try:
            if not in_path or not os.path.exists(in_path):
                emit({"ok": False, "reason": "missing --in file"}, out_path); return
            with open(in_path, encoding="utf-8") as f:
                payload = json.load(f)
        except Exception as e:
            emit({"ok": False, "reason": "bad --in json: %r" % e}, out_path); return
        enqueue(payload, out_path); return
    emit({"ok": False, "reason": "unknown cmd: %s" % cmd})

if __name__ == "__main__":
    main()
