#!/usr/bin/env python3
"""WindsurfAPI issue test suite"""
import json, subprocess, sys, os, time

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"
D = "/root/WindsurfAPI/tmp-testing/results"
os.makedirs(D, exist_ok=True)

def api(model, messages, **kw):
    body = dict(model=model, messages=messages, stream=False)
    body.update(kw)
    r = subprocess.run(["curl", "-sS", "--max-time", "90",
        f"{API}/v1/chat/completions",
        "-H", f"Authorization: Bearer {KEY}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps(body)],
        capture_output=True, text=True, timeout=95)
    try:
        return json.loads(r.stdout)
    except:
        return {"_raw": r.stdout, "_err": r.stderr}

def summarize(r):
    """Extract key info from API response."""
    if "_raw" in r:
        return {"error": "network_error", "raw": r["_raw"][:200]}
    e = r.get("error")
    if e:
        return {"error": e.get("type","?"), "msg": str(e.get("message",""))[:200]}
    c = r.get("choices", [{}])[0]
    m = c.get("message", {}) or {}
    tc = m.get("tool_calls")
    content = str(m.get("content") or "")
    return {
        "ok": True,
        "content": content[:150],
        "finish": c.get("finish_reason", "?"),
        "tool_calls": [t["function"]["name"] for t in tc] if tc else [],
        "tokens": r.get("usage", {}).get("total_tokens", 0),
    }

def run_test(label, models, msg, tools=None, extra_msg=None):
    """Run a test against multiple models."""
    print(f"\n{'='*60}")
    print(f"TEST: {label}")
    print(f"{'='*60}")
    results = {}
    for model in models:
        print(f"\n  [{model}] ", end="", flush=True)
        try:
            r = api(model, [{"role": "user", "content": msg}], tools=tools or [])
            s = summarize(r)
            if s.get("error"):
                print(f"ERROR: {s['error']}")
                if "msg" in s:
                    print(f"    msg: {s['msg'][:120]}")
            elif s.get("tool_calls"):
                print(f"OK tool_calls={len(s['tool_calls'])} names={s['tool_calls']} finish={s['finish']}")
            else:
                print(f"OK (no tools) finish={s['finish']} tokens={s['tokens']} content={s['content'][:80]}")
            results[model] = s
        except Exception as ex:
            print(f"EXCEPTION: {ex}")
            results[model] = {"error": "exception", "msg": str(ex)}
    return results

def run_multi_turn(label, models, turn1_msg, turn2_msg, expected_in_turn2):
    """Test multi-turn context retention."""
    print(f"\n{'='*60}")
    print(f"TEST: {label}")
    print(f"{'='*60}")
    results = {}
    for model in models:
        print(f"\n  [{model}] ", end="", flush=True)
        try:
            r1 = api(model, [{"role": "user", "content": turn1_msg}])
            s1 = summarize(r1)
            t1_content = s1.get("content", "")
            print(f"T1={t1_content[:50]}... ", end="", flush=True)

            r2 = api(model, [
                {"role": "user", "content": turn1_msg},
                {"role": "assistant", "content": t1_content},
                {"role": "user", "content": turn2_msg}
            ])
            s2 = summarize(r2)
            t2_content = s2.get("content", "")
            checks = {}
            for key in expected_in_turn2:
                checks[key] = key in t2_content or key.lower() in t2_content.lower()
            all_pass = all(checks.values())
            print(f"{'PASS' if all_pass else 'FAIL'} checks={checks} t2={t2_content[:80]}")
            results[model] = {"turn1": s1, "turn2": s2, "checks": checks}
        except Exception as ex:
            print(f"EXCEPTION: {ex}")
            results[model] = {"error": "exception", "msg": str(ex)}
    return results


if __name__ == "__main__":
    all_results = {}
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"WindsurfAPI Test Suite — {ts}")
    print(f"API: {API}  Key: {KEY[:8]}...")

    tools_weather = [{"type": "function", "function": {
        "name": "get_weather", "description": "Get weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }}]
    tools_bash = [{"type": "function", "function": {
        "name": "Bash", "description": "Run a shell command",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}
    }}]

    # #125: Tool calls
    all_results["125"] = run_test("#125 Tool Calls",
        ["claude-sonnet-4.6", "claude-opus-4.6", "gemini-2.5-flash",
         "kimi-k2", "glm-4.7", "gpt-5.2", "claude-4.5-haiku"],
        "What is the weather in Tokyo? Use the get_weather function.",
        tools=tools_weather)

    # #120: Free-tier tool calls
    all_results["120"] = run_test("#120 Free Model Tools",
        ["glm-4.7", "kimi-k2", "gemini-2.5-flash"],
        "Run ls -la to list files in this directory. Use the Bash tool.",
        tools=tools_bash)

    # #116: Context reuse
    all_results["116"] = run_multi_turn("#116 Context Reuse",
        ["claude-sonnet-4.6", "gemini-2.5-flash", "claude-4.5-haiku"],
        "My name is TestUser42. I am working on ProjectPhoenix. Remember this.",
        "What is my name and what project am I working on?",
        ["TestUser42", "Phoenix"])

    # #117: Model aliases and deprecated
    all_results["117"] = run_test("#117 Model Issues",
        ["gpt-5.5", "claude-4.5-haiku", "claude-haiku-4-5-20251001",
         "claude-sonnet-4-5-20250929", "gpt-5.2", "glm-5.1",
         "claude-3.5-sonnet", "claude-3.7-sonnet"],
        "hi")

    # #108: Workspace path leakage
    all_results["108"] = run_test("#108 Workspace Sanitization",
        ["gemini-2.5-flash", "claude-sonnet-4.6"],
        "Analyze the current project. What files are in the workspace? What is the project structure and working directory?")

    # Edge: stream
    print(f"\n{'='*60}")
    print(f"TEST: Stream")
    print(f"{'='*60}")
    r = subprocess.run(["curl", "-sS", "--max-time", "30",
        f"{API}/v1/chat/completions",
        "-H", f"Authorization: Bearer {KEY}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"model": "gemini-2.5-flash",
        "messages": [{"role": "user", "content": "Say hello in 3 words."}],
        "stream": True})],
        capture_output=True, text=True, timeout=35)
    has_done = "[DONE]" in r.stdout
    chunks = r.stdout.count("data: ")
    print(f"  chunks={chunks} has_done={has_done}")
    all_results["stream"] = {"chunks": chunks, "has_done": has_done}

    # Save full results
    with open(f"{D}/full-results.json", "w") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2, default=str)

    # Print summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for label, results in all_results.items():
        print(f"\n  [{label}]")
        for model, s in results.items():
            if isinstance(s, dict):
                if s.get("error"):
                    print(f"    FAIL {model}: {s['error']}")
                elif s.get("tool_calls"):
                    print(f"    PASS {model}: tools={s['tool_calls']}")
                elif s.get("checks"):
                    all_ok = all(s["checks"].values())
                    print(f"    {'PASS' if all_ok else 'FAIL'} {model}: {s['checks']}")
                elif s.get("ok"):
                    print(f"    PASS {model}: tokens={s.get('tokens','?')}")
                else:
                    print(f"    INFO {model}: {s}")
            else:
                print(f"    {model}: {s}")

    print(f"\nResults: {D}/full-results.json")
