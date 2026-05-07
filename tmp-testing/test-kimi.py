import json, subprocess
API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

tools_weather = [{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
tools_bash = [{"type":"function","function":{"name":"Bash","description":"Run cmd","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]

for label, model, msg, tools in [
    ("weather", "kimi-k2", "What is the weather in Tokyo? Use get_weather.", tools_weather),
    ("bash", "kimi-k2", "List files in this directory. Use Bash to run ls.", tools_bash),
    ("weather", "glm-4.7", "What is the weather in Tokyo? Use get_weather.", tools_weather),
    ("bash", "glm-4.7", "List files using Bash ls.", tools_bash),
]:
    print(f"[{label}] {model}: ", end="", flush=True)
    body = {"model":model, "messages":[{"role":"user","content":msg}], "tools":tools, "stream":False}
    r = subprocess.run(["curl","-sS","--max-time","90",
        f"{API}/v1/chat/completions",
        "-H",f"Authorization: Bearer {KEY}",
        "-H","Content-Type: application/json",
        "-d",json.dumps(body)],
        capture_output=True, text=True, timeout=95)
    try:
        d = json.loads(r.stdout)
    except:
        print(f"PARSE ERROR: {r.stdout[:200]}")
        continue
    e = d.get("error")
    if e:
        print(f"ERROR: {e['type']} - {str(e.get('message',''))[:120]}")
        continue
    c = d.get("choices",[{}])[0]
    m = c.get("message",{}) or {}
    tc = m.get("tool_calls")
    content = str(m.get("content") or "")[:80]
    tokens = d.get("usage",{}).get("total_tokens","?")
    finish = c.get("finish_reason","?")
    if tc:
        names = [t["function"]["name"] for t in tc]
        print(f"PASS! tools={names} tokens={tokens}")
    else:
        print(f"NO_TOOL finish={finish} tokens={tokens} content={content}")
