"""Quick targeted tests for open issues"""
import json, subprocess, time, sys

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"
MODEL = "gemini-2.5-flash"  # fastest

def api(model, msgs, **kw):
    body = dict(model=model, messages=msgs, stream=False)
    body.update(kw)
    start = time.time()
    r = subprocess.run(["curl","-sS","--max-time","60",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=65)
    try: d = json.loads(r.stdout); d["_t"] = round(time.time()-start,2); return d
    except: return {"_raw": r.stdout[:200], "_t": round(time.time()-start,2)}

def show(r):
    if "_raw" in r: return "NET_ERR:" + r["_raw"][:80]
    e = r.get("error")
    if e: return "ERR:" + e["type"] + " " + str(e.get("message",""))[:80]
    c = r.get("choices",[{}])[0]; m = c.get("message",{}) or {}
    tc = m.get("tool_calls")
    ct = str(m.get("content",""))[:60]
    if tc: return "OK tools=" + str([t["function"]["name"] for t in tc])
    return "OK c=" + ct

results = {}

# ─── #117: GPT models ───
print("=== #117 GPT models ===")
for m in ["gpt-5.5", "gpt-5.4-mini-low", "gpt-5.2"]:
    r = api(m, [{"role":"user","content":"Say hello"}])
    s = show(r)
    t = r.get("_t", 0)
    print(f"  {m}: {s} ({t}s)")
    results[f"117_{m}"] = not r.get("error")

# ─── #117: GPT with tools ───
print("=== #117 GPT-5.5 with tools ===")
tools = [{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
r = api("gpt-5.5", [{"role":"user","content":"Check weather in Tokyo with get_weather."}], tools=tools)
print(f"  gpt-5.5+tools: {show(r)}")
results["117_gpt55_tools"] = "OK tools=" in show(r)

# ─── #133: Context loss scenarios ───
print("=== #133 Context tests ===")
for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
    # 10-turn context
    h = [{"role":"user","content":"I work on ProjectAlpha. The API runs on port 3000. The DB is MongoDB. The config is in /etc/app.yaml. Remember everything."}]
    r1 = api(model, h)
    c1 = str(r1.get("choices",[{}])[0].get("message",{}).get("content",""))
    h.append({"role":"assistant","content":c1})

    context_ok = 0
    for i in range(8):
        prompts = ["What is HTTP?", "What is REST?", "What is JSON?", "Explain caching",
                   "What is load balancing?", "What is microservice?", "What is CI/CD?", "What is GitOps?"]
        r = api(model, h + [{"role":"user","content": prompts[i]}])
        c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
        h = h + [{"role":"user","content": prompts[i]}, {"role":"assistant","content":c}]

    # Final check
    r = api(model, h + [{"role":"user","content":"What is my project name, API port, database, and config path?"}])
    c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
    checks = {"Alpha": "ProjectAlpha" in c, "3000": "3000" in c,
              "Mongo": "Mongo" in c, "yaml": "app.yaml" in c or "yaml" in c}
    ok = sum(1 for v in checks.values() if v)
    print(f"  {model} 10-turns: {ok}/4 recalled ({checks})")
    results[f"133_{model[:8]}"] = ok >= 3

# ─── #130: Codex-like tool use ───
print("=== #130 Codex tool test ===")
r = api("gpt-5.2", [
    {"role":"user","content":"List files in current directory using Bash. Run: ls /tmp"}
], tools=[{"type":"function","function":{"name":"Bash","description":"Run cmd","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}])
print(f"  gpt-5.2+Bash: {show(r)}")
results["130_gpt52_bash"] = "OK tools=" in show(r)

# ─── #132: Rate limit test ───
print("=== #132 Rate limit test ===")
for i in range(5):
    r = api("gemini-2.5-flash", [{"role":"user","content":f"say {i}"}])
    e = r.get("error")
    t = r.get("_t", 0)
    st = "ERR:" + e["type"] if e else "OK"
    print(f"  req{i}: {st} ({t}s)")
    if e: results[f"132_rl_{i}"] = e["type"]

# ─── Summary ───
print("\n=== SUMMARY ===")
fails = [k for k,v in results.items() if isinstance(v, bool) and not v]
errs = [k for k,v in results.items() if isinstance(v, str) and "ERR" in str(v)]
for k,v in sorted(results.items()):
    if isinstance(v, bool): print(f"  {'PASS' if v else 'FAIL'}: {k}")
    else: print(f"  INFO: {k} = {v}")
if fails: print(f"\n{len(fails)} FAILURES: {fails}")
else: print("\nAll checks passed!")
