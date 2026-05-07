"""Test #133: Context retention with tools across multiple turns"""
import json, subprocess

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

tools = [{"type":"function","function":{"name":"Read","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}}]

def api(model, msgs, **kw):
    body = dict(model=model, messages=msgs, stream=False)
    body.update(kw)
    r = subprocess.run(["curl","-sS","--max-time","90",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=95)
    try: return json.loads(r.stdout)
    except: return {"_raw": r.stdout[:500]}

def check(r, desc):
    if "_raw" in r: return f"NET_ERR: {r['_raw'][:100]}"
    e = r.get("error")
    if e: return f"ERR: {e['type']}"
    c = r.get("choices",[{}])[0]
    m = c.get("message",{}) or {}
    tc = m.get("tool_calls")
    content = str(m.get("content",""))[:150]
    tokens = r.get("usage",{}).get("total_tokens","?")
    if tc:
        return f"TOOLS={[t['function']['name'] for t in tc]}"
    return f"OK t={tokens} c={content[:80]}"

print("TEST #133: Context Loss Simulation")
print("=" * 60)

for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
    print(f"\n[{model}] Long multi-turn with tools:")

    history = []

    # Turn 1: Set project context
    print("  T1 (set context): ", end="", flush=True)
    t1 = [{"role":"user","content":"I am working on a project at C:\\Projects\\MyApp. The main entry is src/main.ts. The database config is in config/db.yaml. Remember these paths."}]
    r1 = api(model, t1)
    c1 = str(r1.get("choices",[{}])[0].get("message",{}).get("content",""))
    print(check(r1))
    history = t1 + [{"role":"assistant","content":c1}]

    # Turn 2: Ask to read a file
    print("  T2 (read file): ", end="", flush=True)
    t2 = history + [{"role":"user","content":"Read the database config file using the Read tool."}]
    r2 = api(model, t2, tools=tools)
    c2 = str(r2.get("choices",[{}])[0].get("message",{}).get("content",""))
    tc2 = r2.get("choices",[{}])[0].get("message",{}).get("tool_calls")
    print(check(r2))

    if tc2:
        # Simulate tool result
        history = t2 + [{"role":"assistant","content":c2, "tool_calls":tc2}]
        history.append({"role":"tool","tool_call_id":tc2[0].get("id","call_1"),"content":"database:\n  host: localhost\n  port: 5432\n  name: myapp_db"})
    else:
        history = t2 + [{"role":"assistant","content": c2}]

    # Turn 3: Ask another unrelated question
    print("  T3 (different topic): ", end="", flush=True)
    t3 = history + [{"role":"user","content":"What Python version is best for data science?"}]
    r3 = api(model, t3)
    c3 = str(r3.get("choices",[{}])[0].get("message",{}).get("content",""))
    print(check(r3))
    history = t3 + [{"role":"assistant","content":c3}]

    # Turn 4: KEY TEST - recall project context
    print("  T4 (RECALL project): ", end="", flush=True)
    t4 = history + [{"role":"user","content":"What is my project path and where is the database config?"}]
    r4 = api(model, t4)
    c4 = str(r4.get("choices",[{}])[0].get("message",{}).get("content",""))
    has_project = "MyApp" in c4 or "Projects" in c4
    has_db = "db.yaml" in c4 or "database" in c4.lower()
    tokens4 = r4.get("usage",{}).get("total_tokens","?")
    print(f"project={has_project} db={has_db} tokens={tokens4} c={c4[:80]}")

    # Turn 5: Make another request to see if context holds
    print("  T5 (context check): ", end="", flush=True)
    t5 = history + t4[len(history):]  # full context
    # Ask about the entry point from turn 1
    actual_t5 = history + [
        {"role":"assistant","content": c4},
        {"role":"user","content":"Where is the main entry point of my project? It should be src/main.ts right?"}
    ]
    r5 = api(model, actual_t5)
    c5 = str(r5.get("choices",[{}])[0].get("message",{}).get("content",""))
    has_entry = "main.ts" in c5 or "src/main" in c5
    print(f"entry={has_entry} c={c5[:80]}")

    if has_project and has_db and has_entry:
        print(f"  [{model}] PASS: Full context retained across 5 turns")
    else:
        print(f"  [{model}] ISSUE: project={has_project} db={has_db} entry={has_entry}")
