# Changelog

## 0.1.3 (2026-09-04)

First public release.

- **agent_dispatch tool** — delegate a self-contained task to an external agent,
  results streamed back into the conversation with provenance headers
  (target · model · duration · session/conversation id).
- **Channels**:
  - `codex` — Codex CLI headless (`exec --skip-git-repo-check --ephemeral -m <model>`)
  - `hy3` — WorkBuddy builtin models via the automation bridge (async, minutes;
    subscription promo pricing)
  - `wbmodel` — WorkBuddy custom models (`models.json`) via direct
    OpenAI-compatible calls (sync, sub-second; your own API key)
  - `claude-code` — Claude Code CLI against a configured third-party endpoint,
    with slot-pinning env injection for 2.1.x model-catalog validation
- **Composer two-step dropdown** (`conversation.input.right`): pick agent → pick
  model; button shows the active combo; channel availability auto-greys items.
- **Settings panel**: channel status lights, bridge health probe, per-channel
  test dispatch buttons.
- **Dynamic builtin-model list** for the WorkBuddy channel, aggregated from
  local `sessions.model` ∪ `automations.model_id` with desktop display-name
  mapping — follows the desktop app's lineup automatically.
- **Anti-impersonation**: structural (no self-answer path), provenance headers,
  and an explicit tool-description clause requiring real dispatches.
- Windows hardening: PATHEXT resolution, UTF-8 file-based subprocess IO
  (pipes corrupt CJK under GBK hosts), native-exe entry points.
