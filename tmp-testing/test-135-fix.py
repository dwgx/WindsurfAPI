import json, subprocess
API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

print("=== Testing Claude models after #135 fix ===")
for model in ["claude-sonnet-4.6", "claude-opus-4.6", "claude-4.5-haiku"]:
    print(f"[{model}] ", end="", flush=True)
    body = {"model":model,"messages":[{"role":"user","content":"hi"}],"stream":False}
    r = subprocess.run(["curl","-sS","--max-time","60",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=65)
    try:
        d = json.loads(r.stdout)
    except:
        print(f"PARSE ERROR: {r.stdout[:200]}")
        continue
    e = d.get("error")
    if e:
        print(f"ERROR: {e['type']} - {str(e.get('message',''))[:120]}")
    else:
        c = d.get("choices",[{}])[0]
        content = str(c.get("message",{}).get("content",""))[:80]
        tokens = d.get("usage",{}).get("total_tokens","?")
        print(f"OK tokens={tokens} content={content}")

# Now test stream mode (this was the crash path)
print("\n=== Testing Claude stream mode (was the crash path) ===")
for model in ["claude-sonnet-4.6", "claude-opus-4.6"]:
    print(f"[{model}] stream: ", end="", flush=True)
    body = {"model":model,"messages":[{"role":"user","content":"count to 5"}],"stream":True}
    r = subprocess.run(["curl","-sS","--max-time","60",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=65)
    has_done = "[DONE]" in r.stdout
    chunks = r.stdout.count("data: ")
    has_error = "error" in r.stdout.lower() and '"type":"error"' in r.stdout
    print(f"chunks={chunks} done={has_done} errors={has_error}")
