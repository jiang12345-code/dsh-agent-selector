# WorkBuddy automation bridge — field experiment notes (2026-09-04)

How we proved that a DSH plugin can drive WorkBuddy's builtin models (hy3 /
Hy4 preview / GLM-5.3 family) programmatically, before building the channel.

## Question

WorkBuddy ships no CLI. Is there still a programmable entry point into its
builtin (subscription-priced) models?

## Answer

Yes — its **automation system**. Three facts, all verified on a live install:

1. **The scheduler reads the database on every tick.** WorkBuddy's main process
   runs a `LocalAutomationScheduler` (visible in `~/.workbuddy/logs/automation.log`)
   that scans due jobs every 30s (5s when active, concurrency 3). It queries
   SQLite directly — rows inserted by an *external process* are picked up with no
   app restart.
2. **`next_run_at` (INTEGER, epoch ms) is the only scan key.** A one-shot job
   (`schedule_type='once'`) whose `scheduled_at` is set but `next_run_at` left
   NULL is **never picked up** (our first attempt sat for 4 minutes). Filling
   `next_run_at = now + 45s` got the same row picked up within one tick.
3. **Execution is a full WorkBuddy agent run.** The selected `model_id` (e.g.
   `hy3`) drives the whole agent — tools, skills, file read/write — not a bare
   completion. Results land in the `automation_runs` table (`thread_title` =
   reply digest, `runs_json` = success/timing/conversationId, `result_success`).

## Timeline of the decisive experiment

| t | event |
|---|---|
| +0s | external INSERT of a once task (model `hy3`, scheduled_at = +90s) → **not picked up** (240s) |
| +300s | `UPDATE … SET next_run_at = now+45s` — the decisive fix |
| +74s after fix | scheduler pickup (`run start` in automation.log) |
| +17s | execution done; result file written by the agent |
| immediately after | DSH-side monitor read the output; test rows deleted, table restored |

## Row template that works (once task)

Mirror a real on-device sample; do not invent fields:

```
schedule_type='once', rrule='', status='ACTIVE', model_id='<lowercase-id>',
permission_mode='fullAccess', cwds='["<workdir>"]',
owner_user_id/owner_status='confirmed'/owner_source='created'  -- copied from a live row
next_run_at=<epoch-ms>          -- THE scan key
scheduled_at='<ISO-8601 UTC>'   -- display/creation input only
```

Cleanup discipline: delete your task row and its `automation_runs` row when done.

## Risks

- **Reverse dependency**: the automations schema and the scheduler are internal.
  A WorkBuddy upgrade may break the bridge — the settings panel exposes a probe
  (test dispatch) so breakage is loud, not silent.
- **Quota**: builtin-model dispatch consumes the WorkBuddy subscription
  (that's the point — hy3 at its discounted promo rate).
- **Async**: pickup ≤30s + agent execution; plan for minutes, not seconds.
