import json, subprocess
API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"
tools = [{"type":"function","function":{"name":"Read","description":"Read file","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}}]

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
    except: return {"_raw": r.stdout[:300]}

def chk(r):
    if "_raw" in r: return "NET_ERR"
    e = r.get("error")
    if e: return "ERR:" + e["type"]
    c = r.get("choices", [{}])[0]
    m = c.get("message", {}) or {}
    tc = m.get("tool_calls")
    content = str(m.get("content", ""))[:80]
    tokens = r.get("usage", {}).get("total_tokens", "?")
    if tc:
        names = [t["function"]["name"] for t in tc]
        return "TOOLS=" + str(names) + " t=" + str(tokens)
    return "OK t=" + str(tokens) + " c=" + content

for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
    print("[" + model + "]")

    # Turn 1
    r1 = api(model, [{"role":"user","content":"My project is at C:/Projects/MyApp. Entry: src/main.ts. DB config: config/db.yaml. Remember these paths."}])
    c1 = str(r1.get("choices", [{}])[0].get("message", {}).get("content", ""))
    print(" T1:", chk(r1))
    h = [{"role":"user","content":"My project is at C:/Projects/MyApp. Entry: src/main.ts. DB config: config/db.yaml. Remember these paths."},
         {"role":"assistant","content": c1}]

    # Turn 2: read file
    r2 = api(model, h + [{"role":"user","content":"Read the config/db.yaml file using Read."}], tools=tools)
    c2 = str(r2.get("choices", [{}])[0].get("message", {}).get("content", ""))
    tc2 = r2.get("choices", [{}])[0].get("message", {}).get("tool_calls")
    print(" T2:", chk(r2))
    if tc2:
        h = h + [{"role":"assistant","content": c2, "tool_calls": tc2},
                 {"role":"tool","tool_call_id": tc2[0]["id"], "content": "db_host: localhost\ndb_port: 5432"}]
    else:
        h = h + [{"role":"assistant","content": c2}]

    # Turn 3: different topic
    r3 = api(model, h + [{"role":"user","content":"What Python version is best for data science in 2026?"}])
    c3 = str(r3.get("choices", [{}])[0].get("message", {}).get("content", ""))
    print(" T3:", chk(r3))
    h = h + [{"role":"user","content":"What Python version is best for data science in 2026?"},
             {"role":"assistant","content": c3}]

    # Turn 4: recall project context
    r4 = api(model, h + [{"role":"user","content":"What is my project path and where is the database config file?"}])
    c4 = str(r4.get("choices", [{}])[0].get("message", {}).get("content", ""))
    has_p = "MyApp" in c4 or "Projects" in c4
    has_d = "db.yaml" in c4 or "config/db" in c4
    print(" T4: project=" + str(has_p) + " db=" + str(has_d) + " c=" + c4[:80])

    # Turn 5: recall entry point
    r5 = api(model, h + [{"role":"assistant","content": c4},
               {"role":"user","content":"Where is the TypeScript entry point? It should be src/main.ts right?"}])
    c5 = str(r5.get("choices", [{}])[0].get("message", {}).get("content", ""))
    has_e = "main.ts" in c5 or "src/main" in c5
    print(" T5: entry=" + str(has_e) + " c=" + c5[:80])
    print(" => " + ("PASS" if has_p and has_d and has_e else "ISSUE: p=" + str(has_p) + " d=" + str(has_d) + " e=" + str(has_e)))
