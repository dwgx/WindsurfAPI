"""Test suite for latest open issues on VPS"""
import json, subprocess, sys, time

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

def api(model, messages, **kw):
    body = dict(model=model, messages=messages, stream=False)
    body.update(kw)
    r = subprocess.run(["curl","-sS","--max-time","90",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=95)
    try: return json.loads(r.stdout)
    except: return {"_raw": r.stdout, "_err": r.stderr}

def summarize(r):
    if "_raw" in r: return f"NETWORK: {r['_raw'][:200]}"
    e = r.get("error")
    if e: return f"ERROR: {e['type']} - {str(e.get('message',''))[:150]}"
    c = r.get("choices", [{}])[0]
    m = c.get("message", {}) or {}
    tc = m.get("tool_calls")
    content = str(m.get("content") or "")[:100]
    tokens = r.get("usage", {}).get("total_tokens", "?")
    if tc:
        names = [t["function"]["name"] for t in tc]
        return f"OK tools={names} tokens={tokens}"
    return f"OK finish={c.get('finish_reason','?')} tokens={tokens} content={content[:60]}"

# ─── #131: Content block not found ───
print("=" * 60)
print("TEST #131: Anthropic Messages / Content Block")
print("=" * 60)

# Test /v1/messages endpoint with image+text
print("\n  [/v1/messages basic]:", end=" ", flush=True)
r = subprocess.run(["curl","-sS","--max-time","30",
    f"{API}/v1/messages",
    "-H",f"x-api-key: {KEY}",
    "-H","Content-Type: application/json",
    "-d",json.dumps({
        "model":"claude-sonnet-4-6",
        "max_tokens":100,
        "messages":[{"role":"user","content":"Say hello in one word."}]
    })],
    capture_output=True, text=True, timeout=35)
try:
    d = json.loads(r.stdout)
    e = d.get("error")
    if e: print(f"ERROR: {e['type']}")
    else: print(f"OK type={d.get('type','?')} content={str(d.get('content',[{}])[0].get('text',''))[:50]}")
except:
    print(f"PARSE FAIL: {r.stdout[:200]}")

# Test /v1/messages with tool_use (simulating Claude Code)
print("\n  [/v1/messages with tool_use]:", end=" ", flush=True)
r2 = subprocess.run(["curl","-sS","--max-time","30",
    f"{API}/v1/messages",
    "-H",f"x-api-key: {KEY}",
    "-H","Content-Type: application/json",
    "-d",json.dumps({
        "model":"claude-sonnet-4-6",
        "max_tokens":200,
        "messages":[
            {"role":"user","content":"Read /etc/hostname"},
            {"role":"assistant","content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"cat /etc/hostname"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"tool_1","content":"my-server"}]},
            {"role":"user","content":"What hostname did you see?"}
        ]
    })],
    capture_output=True, text=True, timeout=35)
try:
    d = json.loads(r2.stdout)
    e = d.get("error")
    if e: print(f"ERROR: {e['type']} - {str(e.get('message',''))[:150]}")
    else: print(f"OK type={d.get('type','?')} stop_reason={d.get('stop_reason','?')}")
except:
    print(f"PARSE FAIL: {r2.stdout[:200]}")

# ─── #141: ClaudeCode tool loop ───
print("\n" + "=" * 60)
print("TEST #141: Multi-turn with tools (loop test)")
print("=" * 60)

tools = [{"type":"function","function":{"name":"Bash","description":"Run shell cmd","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
         {"type":"function","function":{"name":"Read","description":"Read file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}}]

for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
    print(f"\n  [{model}] multi-turn tool test:")
    # Turn 1
    print("    T1: ", end="", flush=True)
    r1 = api(model, [{"role":"user","content":"Run 'echo hello' using the Bash tool."}], tools=tools)
    s1 = summarize(r1)
    print(s1)

    # Turn 2: send tool result
    if "tools=" in s1 and "Bash" in s1:
        print("    T2 (tool_result): ", end="", flush=True)
        r2 = api(model, [
            {"role":"user","content":"Run echo hello using Bash."},
            {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":'{"command":"echo hello"}'}}]},
            {"role":"tool","tool_call_id":"call_1","content":"hello"},
            {"role":"user","content":"Now read /etc/hostname using Read."}
        ], tools=tools)
        print(summarize(r2))

    # Turn 3: another round
    print("    T3: ", end="", flush=True)
    r3 = api(model, [
        {"role":"user","content":"Just say OK, nothing else."}
    ])
    print(summarize(r3))

# ─── #133: Context loss mid-task ───
print("\n" + "=" * 60)
print("TEST #133: Context Retention with Tools")
print("=" * 60)

for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
    print(f"\n  [{model}] ", end="", flush=True)
    # Turn 1: set context
    r1 = api(model, [{"role":"user","content":"The project root is D:\\git\\MyProject. The main config is in config.yaml. Remember this."}])
    c1 = str(r1.get("choices",[{}])[0].get("message",{}).get("content",""))[:200]

    # Turn 2: ask a different question
    r2 = api(model, [
        {"role":"user","content":"The project root is D:\\git\\MyProject. The main config is in config.yaml. Remember this."},
        {"role":"assistant","content": c1},
        {"role":"user","content":"What is the project root directory and where is the config file?"}
    ])
    c2 = str(r2.get("choices",[{}])[0].get("message",{}).get("content",""))
    has_root = "D:\\git\\MyProject" in c2 or "MyProject" in c2
    has_config = "config.yaml" in c2 or "config" in c2.lower()
    print(f"root={has_root} config={has_config} t2={c2[:80]}")

# ─── #130: Codex/gpt-5.4 models ───
print("\n" + "=" * 60)
print("TEST #130/#136: GPT models + large prompts")
print("=" * 60)

for model in ["gpt-5.4-mini-low", "gpt-5.4", "gpt-5.2", "claude-sonnet-4.6"]:
    print(f"  [{model}]: ", end="", flush=True)
    r = api(model, [{"role":"user","content":"hi"}])
    print(summarize(r))

# ─── #134: Login check ───
print("\n" + "=" * 60)
print("TEST #134: Auth endpoint health")
print("=" * 60)

r = subprocess.run(["curl","-sS","--max-time","10",
    f"{API}/auth/status",
    "-H",f"Authorization: Bearer {KEY}"],
    capture_output=True, text=True, timeout=15)
try:
    d = json.loads(r.stdout)
    print(f"  Auth status: {d}")
except:
    print(f"  Raw: {r.stdout[:200]}")

# Check windsurf-login code for Auth1
print("\n  Checking windsurf-login error paths...")
r = subprocess.run(["curl","-sS","--max-time","30",
    f"{API}/dashboard/api/windsurf-login",
    "-H","Content-Type: application/json",
    "-H",f"X-Dashboard-Password: {KEY}",
    "-d",json.dumps({"email":"test@test.com","password":"wrong","autoAdd":False})],
    capture_output=True, text=True, timeout=35)
print(f"  Login test (bad creds): {r.stdout[:200]}")

print("\n" + "=" * 60)
print("ALL TESTS COMPLETE")
print("=" * 60)
