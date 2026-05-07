"""WindsurfAPI Stress Test — simulate Claude Code usage patterns"""
import json, subprocess, time, sys, os, traceback

API = "http://localhost:3888"
KEY = "sk-dwgxnbnb888"
LOG_FILE = "/root/WindsurfAPI/tmp-testing/results/stress-test.jsonl"

tools_read = [{"type":"function","function":{"name":"Read","description":"Read a file","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to read"}},"required":["file_path"]}}}]

tools_bash = [{"type":"function","function":{"name":"Bash","description":"Run shell command","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Command to run"}},"required":["command"]}}}]

tools_write = [{"type":"function","function":{"name":"Write","description":"Write to file","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}}}]

tools_all = tools_read + tools_bash + tools_write

def api(model, msgs, **kw):
    body = dict(model=model, messages=msgs, stream=False)
    body.update(kw)
    start = time.time()
    try:
        r = subprocess.run(["curl","-sS","--max-time","90",
            f"{API}/v1/chat/completions",
            "-H",f"Authorization: Bearer {KEY}",
            "-H","Content-Type: application/json",
            "-d",json.dumps(body)],
            capture_output=True, text=True, timeout=95)
        elapsed = time.time() - start
        d = json.loads(r.stdout)
        d["_elapsed"] = round(elapsed, 2)
        return d
    except Exception as e:
        return {"_raw": str(r.stdout)[:200] if 'r' in dir() else "", "_err": str(e), "_elapsed": round(time.time()-start,2)}

def log_result(line):
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")

# ─── Test 1: Long multi-turn context ───
def test_long_context(model, turns=20):
    """Test context retention across N turns with tool calls interspersed."""
    print(f"\n[LONG-CTX] {model} — {turns} turns")
    history = []
    facts_given = []
    facts_recalled = []
    tool_uses = 0
    failures = 0

    # Initial context
    t1 = api(model, [{"role":"user","content":"I have a project at /home/dev/webapp. The API server is on port 8080. The database is PostgreSQL on localhost:5432. Remember these facts."}])
    if t1.get("error"):
        print(f"  FAIL T1: {t1['error']['type']}")
        return {"pass": False, "reason": f"init_error:{t1['error']['type']}"}

    c1 = str(t1.get("choices",[{}])[0].get("message",{}).get("content",""))
    history = [{"role":"user","content":"I have a project at /home/dev/webapp. The API server is on port 8080. The database is PostgreSQL on localhost:5432. Remember these facts."},
               {"role":"assistant","content": c1}]
    facts_given = ["webapp", "8080", "PostgreSQL"]

    for i in range(turns - 1):
        # Every 5th turn is a tool call
        if i % 5 == 4:
            prompt = "Read the file /etc/hostname using the Read tool."
            r = api(model, history + [{"role":"user","content": prompt}], tools=tools_read)
            tc = r.get("choices",[{}])[0].get("message",{}).get("tool_calls")
            if tc:
                tool_uses += 1
                c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
                history = history + [{"role":"user","content": prompt},
                                     {"role":"assistant","content":c,"tool_calls":tc},
                                     {"role":"tool","tool_call_id":tc[0]["id"],"content":"my-hostname-01"}]
            else:
                c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
                history = history + [{"role":"user","content": prompt},
                                     {"role":"assistant","content":c}]
        # Every 8th turn checks context
        elif i % 8 == 7:
            prompt = "What is my project directory and what port is the API server on?"
            r = api(model, history + [{"role":"user","content": prompt}])
            c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
            has_webapp = "webapp" in c
            has_port = "8080" in c
            recalled = has_webapp and has_port
            facts_recalled.append(recalled)
            if not recalled:
                failures += 1
                print(f"  T{i+1}: CONTEXT LOST! webapp={has_webapp} port={has_port} c={c[:80]}")
            history = history + [{"role":"user","content": prompt},
                                 {"role":"assistant","content":c}]
        # Normal turn
        else:
            topics = ["What is Python?", "Explain git", "How does HTTP work?",
                      "What is Docker?", "Explain JSON", "What is SQL?",
                      "Explain REST API", "What is Node.js?", "Describe Linux",
                      "What is cloud computing?"]
            prompt = topics[i % len(topics)]
            r = api(model, history + [{"role":"user","content": prompt}])
            c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
            history = history + [{"role":"user","content": prompt},
                                 {"role":"assistant","content":c}]

    total_checks = len(facts_recalled)
    pass_rate = (total_checks - failures) / total_checks if total_checks > 0 else 0
    result = {"pass": failures == 0, "model": model, "turns": turns,
              "checks": total_checks, "failures": failures, "pass_rate": pass_rate,
              "tool_uses": tool_uses}
    status = "PASS" if failures == 0 else f"FAIL ({failures}/{total_checks})"
    print(f"  {status} tool_uses={tool_uses} history_len={len(history)}")
    log_result({"test": "long_context", **result})
    return result

# ─── Test 2: Tool loop stress ───
def test_tool_loop(model, iterations=15):
    """Alternate between tool calls and tool results like Claude Code does."""
    print(f"\n[TOOL-LOOP] {model} — {iterations} iterations")
    history = [{"role":"user","content":"You are helping write a script. Use tools when asked."}]
    r = api(model, history)
    c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
    history.append({"role":"assistant","content":c})

    tool_success = 0
    tool_fail = 0
    context_checks = []

    for i in range(iterations):
        if i % 2 == 0:
            # Ask to run a command
            cmd = f"echo 'iteration_{i}'" if i % 4 == 0 else f"ls /tmp"
            r = api(model, history + [{"role":"user","content":f"Run this command: {cmd}. Use Bash."}], tools=tools_bash)
        else:
            # Ask to read a file
            r = api(model, history + [{"role":"user","content":"Read /etc/hostname using Read."}], tools=tools_read)

        c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
        tc = r.get("choices",[{}])[0].get("message",{}).get("tool_calls")

        if tc:
            tool_success += 1
            tid = tc[0]["id"]
            tname = tc[0]["function"]["name"]
            history = history + [{"role":"user","content":f"Run tool"},
                                 {"role":"assistant","content":c,"tool_calls":tc},
                                 {"role":"tool","tool_call_id":tid,"content":f"result_{i}"}]
        else:
            tool_fail += 1
            history = history + [{"role":"user","content":f"Run tool"},
                                 {"role":"assistant","content":c}]

        # Every 5 iterations check context
        if i > 0 and i % 5 == 0:
            r = api(model, history + [{"role":"user","content":"What was the first thing I asked you to do?"}])
            c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
            has_script = "script" in c.lower() or "helping" in c.lower()
            context_checks.append(has_script)
            if not has_script:
                print(f"  iter{i}: context check FAIL c={c[:80]}")

    result = {"pass": tool_success > 0 and all(context_checks) if context_checks else True,
              "model": model, "iterations": iterations, "tool_success": tool_success,
              "tool_fail": tool_fail, "context_lost": sum(1 for x in context_checks if not x)}
    status = "PASS" if result["pass"] else "FAIL"
    print(f"  {status} tools_ok={tool_success}/{iterations} context_lost={result['context_lost']}")
    log_result({"test": "tool_loop", **result})
    return result

# ─── Test 3: Concurrent stress ───
def test_concurrent(model, count=10):
    """Send concurrent requests and check all succeed."""
    print(f"\n[CONCURRENT] {model} — {count} requests")
    import concurrent.futures

    def single_req(i):
        return api(model, [{"role":"user","content":f"Say the number {i} and nothing else."}])

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = [ex.submit(single_req, i) for i in range(count)]
        results = []
        for f in concurrent.futures.as_completed(futures):
            r = f.result()
            has_num = False
            if not r.get("error"):
                c = str(r.get("choices",[{}])[0].get("message",{}).get("content",""))
                has_num = any(str(i) in c for i in range(count))
            results.append({"ok": not r.get("error"), "has_number": has_num})

    ok = sum(1 for r in results if r["ok"])
    fail = sum(1 for r in results if not r["ok"])
    result = {"pass": fail == 0, "model": model, "total": count, "ok": ok, "fail": fail}
    status = "PASS" if fail == 0 else f"FAIL ({fail}/{count})"
    print(f"  {status}")
    log_result({"test": "concurrent", **result})
    return result

# ─── Test 4: Rate limit / account switch stress ───
def test_rapid_requests(model, count=8):
    """Send rapid requests to trigger account rotation."""
    print(f"\n[RAPID] {model} — {count} rapid requests")
    results = []
    for i in range(count):
        r = api(model, [{"role":"user","content":f"Say {i}"}])
        e = r.get("error")
        ok = not e
        err_type = e["type"] if e else None
        elapsed = r.get("_elapsed", 0)
        results.append({"i": i, "ok": ok, "error": err_type, "elapsed": elapsed})
        if e:
            print(f"  req{i}: {err_type} ({elapsed}s)")
        else:
            print(f"  req{i}: OK ({elapsed}s)")

    ok_count = sum(1 for r in results if r["ok"])
    rate_limited = sum(1 for r in results if r.get("error") == "rate_limit_exceeded")
    result = {"pass": ok_count > 0, "model": model, "total": count,
              "ok": ok_count, "rate_limited": rate_limited}
    log_result({"test": "rapid", **result})
    return result

# ─── Test 5: File write/read cycle ───
def test_write_read_cycle(model, cycles=5):
    """Simulate writing and reading files like Claude Code."""
    print(f"\n[WRITE-READ] {model} — {cycles} cycles")
    success = 0
    for i in range(cycles):
        # Write
        rw = api(model, [
            {"role":"user","content":f"Write a Python script to /tmp/test_{i}.py that defines a function fibonacci(n). Use Write tool."}
        ], tools=tools_write)

        cw = str(rw.get("choices",[{}])[0].get("message",{}).get("content",""))
        tcw = rw.get("choices",[{}])[0].get("message",{}).get("tool_calls")

        if tcw and any(t["function"]["name"] == "Write" for t in tcw):
            # Simulate tool result
            history = [
                {"role":"user","content":f"Write fibonacci to /tmp/test_{i}.py"},
                {"role":"assistant","content":cw,"tool_calls":tcw},
                {"role":"tool","tool_call_id":tcw[0]["id"],"content":"def fibonacci(n):\n    if n <= 1: return n\n    return fibonacci(n-1) + fibonacci(n-2)"}
            ]

            # Read back
            rr = api(model, history + [
                {"role":"user","content":f"Now read back /tmp/test_{i}.py using Read to verify it was written correctly."}
            ], tools=tools_read)
            cr = str(rr.get("choices",[{}])[0].get("message",{}).get("content",""))
            tcr = rr.get("choices",[{}])[0].get("message",{}).get("tool_calls")

            if tcr and any(t["function"]["name"] == "Read" for t in tcr):
                success += 1
                print(f"  cycle{i}: Write→Read OK")
            else:
                print(f"  cycle{i}: Write OK but Read failed c={cr[:60]}")
        else:
            print(f"  cycle{i}: Write failed c={cw[:60]}")

    result = {"pass": success >= cycles * 0.8, "model": model, "cycles": cycles, "success": success}
    status = "PASS" if result["pass"] else f"FAIL ({success}/{cycles})"
    print(f"  {status}")
    log_result({"test": "write_read", **result})
    return result

# ─── Main ───
if __name__ == "__main__":
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    print("=" * 60)
    print("WindsurfAPI STRESS TEST")
    print("=" * 60)

    all_results = []

    # Long context: 20-turn test
    for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
        all_results.append(test_long_context(model, 20))
        all_results.append(test_tool_loop(model, 15))

    # Concurrent
    all_results.append(test_concurrent("gemini-2.5-flash", 10))

    # Rapid requests
    all_results.append(test_rapid_requests("gemini-2.5-flash", 8))

    # Write/Read cycles
    for model in ["claude-sonnet-4.6", "gemini-2.5-flash"]:
        all_results.append(test_write_read_cycle(model, 5))

    # Summary
    print("\n" + "=" * 60)
    print("STRESS TEST SUMMARY")
    print("=" * 60)
    failures = [r for r in all_results if not r["pass"]]
    for r in all_results:
        status = "PASS" if r["pass"] else "FAIL"
        test = r.get("test","?")
        model = r.get("model","?")
        if test == "long_context":
            print(f"  [{status}] {test} {model}: {r['failures']}/{r['checks']} context lost")
        elif test == "tool_loop":
            print(f"  [{status}] {test} {model}: {r['tool_success']} tools, {r['context_lost']} context lost")
        elif test in ("concurrent", "rapid"):
            print(f"  [{status}] {test} {model}: {r.get('ok','?')}/{r.get('total','?')} ok")
        elif test == "write_read":
            print(f"  [{status}] {test} {model}: {r['success']}/{r['cycles']} cycles")

    if failures:
        print(f"\n{len(failures)} FAILURES:")
        for f in failures:
            print(f"  {f['test']} {f.get('model','')}: {f}")
    else:
        print("\nALL TESTS PASSED")
