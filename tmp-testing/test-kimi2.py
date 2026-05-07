import json, subprocess
API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"

# Test 1: kimi-k2 plain chat (no tools)
print("=== kimi-k2 plain chat (no tools) ===")
body = {"model":"kimi-k2","messages":[{"role":"user","content":"Say hello and tell me what model you are."}],"stream":False}
r = subprocess.run(["curl","-sS","--max-time","60",
    f"{API}/v1/chat/completions",
    "-H",f"Authorization: Bearer {KEY}",
    "-H","Content-Type: application/json",
    "-d",json.dumps(body)],
    capture_output=True, text=True, timeout=65)
d = json.loads(r.stdout)
e = d.get("error")
if e:
    print(f"  ERROR: {e['type']}")
else:
    c = d.get("choices",[{}])[0]
    content = str(c.get("message",{}).get("content",""))[:150]
    tokens = d.get("usage",{}).get("total_tokens","?")
    print(f"  OK tokens={tokens} content={content}")

# Test 2: kimi-k2 with tools, more explicit prompt
print("\n=== kimi-k2 tools (explicit) ===")
tools = [{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}}]
body2 = {"model":"kimi-k2","messages":[{"role":"user","content":"I need to check the weather in Tokyo. Please call the get_weather function with city=Tokyo."}],"tools":tools,"stream":False}
r2 = subprocess.run(["curl","-sS","--max-time","60",
    f"{API}/v1/chat/completions",
    "-H",f"Authorization: Bearer {KEY}",
    "-H","Content-Type: application/json",
    "-d",json.dumps(body2)],
    capture_output=True, text=True, timeout=65)
d2 = json.loads(r2.stdout)
e2 = d2.get("error")
if e2:
    print(f"  ERROR: {e2['type']} - {str(e2.get('message',''))[:150]}")
else:
    c2 = d2.get("choices",[{}])[0]
    m2 = c2.get("message",{}) or {}
    tc = m2.get("tool_calls")
    content = str(m2.get("content",""))[:100]
    finish = c2.get("finish_reason","?")
    tokens = d2.get("usage",{}).get("total_tokens","?")
    if tc:
        print(f"  PASS tools={[t['function']['name'] for t in tc]} finish={finish} tokens={tokens}")
    else:
        print(f"  NO_TOOL finish={finish} tokens={tokens} content={content}")

# Test 3: glm-4.7 with same old prompt that worked before
print("\n=== glm-4.7 tools (same prompt as old passing test) ===")
body3 = {"model":"glm-4.7","messages":[{"role":"user","content":"What is the weather in Tokyo? Use the get_weather function."}],"tools":tools,"stream":False}
r3 = subprocess.run(["curl","-sS","--max-time","60",f"{API}/v1/chat/completions","-H",f"Authorization: Bearer {KEY}","-H","Content-Type: application/json","-d",json.dumps(body3)],capture_output=True,text=True,timeout=65)
d3 = json.loads(r3.stdout)
e3 = d3.get("error")
if e3:
    print(f"  ERROR: {e3['type']}")
else:
    c3 = d3.get("choices",[{}])[0]
    m3 = c3.get("message",{}) or {}
    tc3 = m3.get("tool_calls")
    content3 = str(m3.get("content",""))[:100]
    finish3 = c3.get("finish_reason","?")
    tokens3 = d3.get("usage",{}).get("total_tokens","?")
    if tc3:
        print(f"  PASS tools={[t['function']['name'] for t in tc3]} finish={finish3} tokens={tokens3}")
    else:
        print(f"  NO_TOOL finish={finish3} tokens={tokens3} content={content3}")
