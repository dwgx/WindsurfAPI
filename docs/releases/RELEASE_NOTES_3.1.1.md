# v3.1.1 — Docker defaults to native tool calling, fable env-lift fix

2026-07-10 (UTC+9)

A small follow-up to v3.1.0. Two changes, both aimed at agent clients (Claude
Code / Cline / Codex) that declare tools: Docker now opts into the native
tool-call path out of the box, and the fable family no longer idles to an empty
completion when a caller `<env>` block is present.

## Fixed

- **`claude-5-fable-*` empty completion with tools + `<env>` (#209).** On the
  prompt-emulation path, lifting the caller's `<env>` block (working directory /
  git status / platform) into the proto `tool_calling_section` alongside tools
  made the fable planner return 0 text / 0 thinking / 0 tool_calls. The env-lift
  is now skipped for the weak-model family (`shouldLiftCallerEnv`), and a global
  escape hatch `WINDSURFAPI_ENV_LIFT=0` disables it for every model. Non-fable
  models are byte-identical — they still get the env-lift.

## Changed

- **Docker defaults `DEVIN_CONNECT=1`.** A fresh `docker compose up` now uses the
  pure-HTTP cloud egress + native tool-call path out of the box. Native is what
  lets weaker models (glm-5.2 etc.) follow the tool protocol reliably in agentic
  clients — with `DEVIN_CONNECT` OFF, requests fall back to Cascade +
  prompt-emulation, where those models intermittently narrate instead of
  emitting a tool_call (root cause of #210). Overridable: set `DEVIN_CONNECT=0`
  in your `.env` to force the legacy Cascade path. Bare-source / systemd deploys
  are unchanged (the code default stays OFF; only the Docker compose env opts in).

## Notes

- #210 ("无法在 claude code 持续运行", glm-5.2) was reproduced live: on the
  emulation path glm-5.2 dropped ~1/3 of turns to narration-instead-of-tool_call;
  on the native path (`DEVIN_CONNECT=1`) it ran 50+ consecutive tool calls with
  zero stalls. The Docker default change is the fix.
- `tools/model-probe.mjs` gained a `--tool-follow` / `--repeat` mode that
  quantifies tool-call adherence per model (the glm-vs-fable comparison).
- Verified: full test suite green (2493), i18n check green.
