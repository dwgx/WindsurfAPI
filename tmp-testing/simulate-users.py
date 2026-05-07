"""Simulate user-reported issues on VPS"""
import json, subprocess, time, sys

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

def api(model, msgs, **kw):
    body = dict(model=model, messages=msgs, stream=False)
    body.update(kw)
    r = subprocess.run(["curl","-sS","--max-time","120",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=125)
    try: return json.loads(r.stdout)
    except: return {"_raw": r.stdout[:500]}

def check(r, label):
    if "_raw" in r: return f"{label}: NET_ERR"
    e = r.get("error")
    if e: return f"{label}: ERR {e['type']} - {str(e.get('message',''))[:100]}"
    c = r.get("choices",[{}])[0]; m = c.get("message",{}) or {}
    tc = m.get("tool_calls")
    ct = str(m.get("content",""))[:80]
    tokens = r.get("usage",{}).get("total_tokens","?")
    t = r.get("_elapsed","?")
    if tc: return f"{label}: TOOLS={[t['f']['name'] for t in tc]} tk={tokens}"
    return f"{label}: OK tk={tokens} c={ct}"

results = {}

# ═══ #143 / #148: Opus-4-7-max + large prompt timeout ═══
print("=== SIM #143: opus-4-7-max + large prompt ===")
large_msg = "Write a detailed analysis of Python web frameworks including Flask, Django, FastAPI, and Litestar. Compare their performance, ease of use, community support, and best use cases. Be thorough and include code examples for each framework." + " " * 500
r1 = api("claude-opus-4-7-max", [{"role":"user","content": large_msg}])
results["143_opus_max_large"] = not r1.get("error")
print(f"  {check(r1, 'opus-4-7-max large')}")

# Also test with tool calls (like opencode does)
tools = [{"type":"function","function":{"name":"Read","description":"Read file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]
r1b = api("claude-opus-4-7-max", [{"role":"user","content":"Read the file /etc/hostname using the Read tool."}], tools=tools)
results["143_opus_max_tools"] = not r1b.get("error")
print(f"  {check(r1b, 'opus-4-7-max+tools')}")

# Test opus-4-6 as lighter alternative
r1c = api("claude-opus-4.6", [{"role":"user","content": large_msg}])
results["143_opus46_large"] = not r1c.get("error")
print(f"  {check(r1c, 'opus-4.6 large')}")
print(f"  opus-4.6 time: {r1c.get('_elapsed','?')}s vs opus-max: {r1.get('_elapsed','?')}s")

# ═══ #130: Codex Devin token content filter ═══
print("\n=== SIM #130: Codex/Devin brand tokens ===")
devin_prompt = "You are Devin AI Assistant, developed by Devin Inc. Your devin-session-token is abc123. I need you to write a Python function."
r2 = api("gemini-2.5-flash", [{"role":"system","content": devin_prompt}, {"role":"user","content":"Write a hello world function in Python."}])
results["130_devin_tokens"] = not r2.get("error")
print(f"  {check(r2, 'devin system prompt')}")

# ═══ #132: Rate limit burst ═══
print("\n=== SIM #132: Rapid burst (8 reqs) ===")
rl_errors = 0
for i in range(8):
    r3 = api("gemini-2.5-flash", [{"role":"user","content": f"say {i}"}])
    e = r3.get("error")
    if e:
        rl_errors += 1
        print(f"  req{i}: ERR {e['type']} ({r3.get('_elapsed','?')}s)")
    else:
        print(f"  req{i}: OK ({r3.get('_elapsed','?')}s)")
results["132_burst"] = rl_errors

# ═══ #125/#120: GLM tool compliance + NLU retry ═══
print("\n=== SIM #125/#120: GLM-4.7 tools ===")
bash_tool = [{"type":"function","function":{"name":"Bash","description":"Run shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]
for attempt in range(3):
    r4 = api("glm-4.7", [{"role":"user","content":"List all files in the current directory using Bash."}], tools=bash_tool)
    c4 = r4.get("choices",[{}])[0]; m4 = c4.get("message",{}) or {}
    tc = m4.get("tool_calls")
    if tc:
        names = [t["function"]["name"] for t in tc]
        print(f"  glm-4.7 attempt{attempt}: TOOLS={names} ✅")
        results["125_glm47"] = True
        break
    else:
        print(f"  glm-4.7 attempt{attempt}: NO_TOOL c={str(m4.get('content',''))[:80]}")
        results["125_glm47"] = False

# Also test kimi-k2
print("\n=== SIM #125: kimi-k2 tools ===")
r5 = api("kimi-k2", [{"role":"user","content":"Say hello, what model are you?"}])
results["125_kimi_basic"] = not r5.get("error")
print(f"  {check(r5, 'kimi-k2 basic')}")
r5b = api("kimi-k2", [{"role":"user","content":"List files using Bash."}], tools=bash_tool)
results["125_kimi_tools"] = not r5b.get("error")
print(f"  {check(r5b, 'kimi-k2+tools')}")

# ═══ Summary ═══
print("\n" + "=" * 50)
print("SIMULATION RESULTS")
print("=" * 50)
for k, v in results.items():
    status = "PASS" if v else "ISSUE"
    print(f"  [{status}] {k}")

# Check docker logs for any errors during tests
r = subprocess.run(["docker","logs","windsurfapi-windsurf-api-1","--tail","10"],
    capture_output=True, text=True, timeout=10)
print("\n=== Last docker logs ===")
for line in r.stdout.strip().split('\n')[-6:]:
    print(f"  {line[:150]}")
