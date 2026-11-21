// Smart account-text parser — ported from xinghuo-windsurf accountTextParser.js
// (users own project). Pure string parsing, no network. Recognizes mixed formats:
// devin-session-token$ / show-auth-token URL / Firebase-refresh-JWT / email----password /
// labeled pairs (邮箱:xxx + Token:auth1_xxx). CommonJS→ESM: exports at bottom.
'use strict';

function isValidEmail(arg1) {
  if (!arg1 || typeof arg1 !== "string") {
    return false;
  }
  const trimResult = arg1.trim();
  if (trimResult.length < 5 || trimResult.length > 254) {
    return false;
  }
  if (/[\s|;,，；\t]/.test(trimResult)) {
    return false;
  }
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(trimResult);
}
function stripWxHints(arg1) {
  if (!arg1) {
    return arg1;
  }
  let v2;
  let v3 = arg1;
  do {
    v2 = v3;
    v3 = v3.replace(/[（(]\s*(?:无任何空格|去掉点|去点|去掉空格|无空格)\s*[）)]/g, "").replace(/\s+账号管理器\s*[:：=＝]\s*\S+/, "").trim();
  } while (v3 !== v2 && v3.length > 0);
  return v3;
}
function isNoiseLine(arg1) {
  if (!arg1) {
    return true;
  }
  if (/^(?:您的|您好|自动发货|订单编号|订单号|交易号|发货时间|订单时间|发货成功|交易成功|尊敬的)/.test(arg1)) {
    return true;
  }
  if (/^\s*\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}[\s\d:：年月日时分秒]*$/.test(arg1)) {
    return true;
  }
  if (/^(?:账号管理器|管理面板|管理后台|官网|官方网站|官方地址|商城|售后|客服|发货)\s*[:：=＝]/.test(arg1)) {
    return true;
  }
  return false;
}
const RE_TOKEN_PREFIX = /^(devin-session-token\$|auth1_|sk-)/i;
const RE_JWT = /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/;
// Any absolute URL scheme, not just http(s): the desktop app's sign-in
// callback is `windsurf://codeium.windsurf?access_token=…` (F4).
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;
function looksLikeToken(arg1) {
  if (!arg1) {
    return false;
  }
  if (arg1.includes("@")) {
    return false;
  }
  if (/[\s|]|----/.test(arg1)) {
    return false;
  }
  if (RE_TOKEN_PREFIX.test(arg1)) {
    return true;
  }
  if (RE_JWT.test(arg1)) {
    return true;
  }
  if (arg1.length >= 60 && /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(arg1)) {
    return true;
  }
  return false;
}
function tryPair(arg1, arg2) {
  const trimResult = (arg1 || "").trim();
  const trimResult2 = (arg2 || "").trim();
  if (!trimResult || !trimResult2) {
    return null;
  }
  const isvalidemailResult = isValidEmail(trimResult);
  const isvalidemailResult2 = isValidEmail(trimResult2);
  if (isvalidemailResult && !isvalidemailResult2) {
    return {
      email: trimResult,
      password: trimResult2
    };
  }
  if (isvalidemailResult2 && !isvalidemailResult) {
    return {
      email: trimResult2,
      password: trimResult
    };
  }
  if (isvalidemailResult && isvalidemailResult2) {
    return {
      email: trimResult,
      password: trimResult2
    };
  }
  return null;
}
function parseSingleLine(arg1) {
  if (/----+/.test(arg1)) {
    const searchResult = arg1.search(/----+/);
    const matchResult2 = arg1.substring(searchResult).match(/^----+/);
    if (matchResult2) {
      const trypairResult = tryPair(arg1.substring(0, searchResult), arg1.substring(searchResult + matchResult2[0].length));
      if (trypairResult) {
        return trypairResult;
      }
    }
  }
  if (arg1.includes("\t")) {
    const indexofResult = arg1.indexOf("\t");
    const trypairResult = tryPair(arg1.substring(0, indexofResult), arg1.substring(indexofResult + 1));
    if (trypairResult) {
      return trypairResult;
    }
  }
  if (!ABSOLUTE_URL_RE.test(arg1)) {
    const searchResult = arg1.search(/[:：=＝]/);
    if (searchResult !== -1) {
      const trypairResult = tryPair(arg1.substring(0, searchResult), arg1.substring(searchResult + 1));
      if (trypairResult) {
        return trypairResult;
      }
    }
  }
  if (arg1.includes("|")) {
    const indexofResult = arg1.indexOf("|");
    const trypairResult = tryPair(arg1.substring(0, indexofResult), arg1.substring(indexofResult + 1));
    if (trypairResult) {
      return trypairResult;
    }
  }
  for (const v1 of [",", ";", "，", "；"]) {
    if (arg1.includes(v1)) {
      const splitResult = arg1.split(v1);
      if (splitResult.length === 2) {
        const trypairResult = tryPair(splitResult[0], splitResult[1]);
        if (trypairResult) {
          return trypairResult;
        }
      }
    }
  }
  const matchResult = arg1.match(/^(\S+)\s+(\S.*?)\s*$/);
  if (matchResult) {
    const trypairResult = tryPair(matchResult[1], matchResult[2]);
    if (trypairResult) {
      return trypairResult;
    }
  }
  return null;
}
const RE_LABEL_EMAIL = /^\s*(?:邮箱|邮件|账号|账户|帐号|帐户|用户名|用户名称|用户|登录名|登陆名|登录账号|登陆账号|登录账户|卡号|号码|账户名|e[\-\s]?mail|email|account|user(?:name)?|login|mail|id|number|num)\s*\d*\s*[:：=＝]\s*/i;
const RE_LABEL_PASS = /^\s*(?:密码|登录密码|登陆密码|口令|秘钥|密钥|卡密|令牌|password|pass(?:word|wd)?|pwd|secret|key|token|access(?:[\-_]?token)?)\s*\d*\s*[:：=＝]\s*/i;
function parseAccountText(content, { includeDiagnostics = false, preview = false } = {}) {
  const arr = [];
  const arr2 = [];
  const arr3 = [];
  const arr4 = [];
  const unrecognizedLines = [];
  const unrecognizedEntries = [];
  function invalidPreviewToken(value) {
    if (!preview || !ABSOLUTE_URL_RE.test(value)) return false;
    try { return !unwrapPastedSecret(value); } catch { return true; }
  }
  if (!content || typeof content !== "string") {
    return {
      accounts: arr,
      tokens: arr2,
      tokenPairs: arr3,
      githubAccounts: arr4,
      ...(includeDiagnostics ? { unrecognizedLines } : {})
    };
  }
  const trimResult = content.trim();
  if (trimResult.startsWith("[") && trimResult.endsWith("]")) {
    try {
      const parseResult = JSON.parse(trimResult);
      if (Array.isArray(parseResult) && parseResult.length > 0) {
        let v12 = true;
        const arr6 = [];
        const arr7 = [];
        const arr8 = [];
        const arr9 = [];
        for (const [index, v13] of parseResult.entries()) {
          if (!v13 || typeof v13 !== "object") {
            if (includeDiagnostics) {
              unrecognizedEntries.push(index + 1);
              continue;
            }
            v12 = false;
            break;
          }
          const v14 = v13.username || v13.user || v13.login;
          const v22 = v13.password || v13.pass || v13.pwd;
          const v32 = v13.totp_secret || v13.totp || v13.totpSecret;
          if (v14 && v22 && v32) {
            if (includeDiagnostics) unrecognizedEntries.push(index + 1);
            arr9.push({
              username: String(v14).trim(),
              password: String(v22).trim(),
              totpSecret: String(v32).trim()
            });
            continue;
          }
          const v4 = v13.email || v13.username || v13.account || v13.user || v13.mail || v13.login;
          const v5 = v13.password || v13.pass || v13.pwd || v13.passwd || v13.secret;
          const v6 = v13.token || v13.sessionToken || v13.session_token || v13.authToken || v13.access_token;
          if (v4 && v5 && isValidEmail(String(v4).trim())) {
            arr6.push({
              email: String(v4).trim(),
              password: String(v5).trim()
            });
          } else if (v6 && invalidPreviewToken(String(v6).trim())) {
            unrecognizedEntries.push(index + 1);
          } else if (v6 && v4 && isValidEmail(String(v4).trim())) {
            arr8.push({
              email: String(v4).trim(),
              token: String(v6).trim()
            });
          } else if (v6) {
            arr7.push(String(v6).trim());
          } else {
            if (includeDiagnostics) {
              unrecognizedEntries.push(index + 1);
              continue;
            }
            v12 = false;
            break;
          }
        }
        if (v12 && (arr6.length || arr7.length || arr8.length || arr9.length || unrecognizedEntries.length)) {
          return {
            accounts: arr6,
            tokens: arr7,
            tokenPairs: arr8,
            githubAccounts: arr9,
            ...(includeDiagnostics ? { unrecognizedLines, unrecognizedEntries } : {})
          };
        }
      }
    } catch (err) {}
  }
  const arr5 = [];
  for (const [index, v12] of content.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const addLine = fields => {
      if (fields.type === "token" && invalidPreviewToken(fields.raw)) {
        unrecognizedLines.push(lineNumber);
        return;
      }
      arr5.push({ lineNumber, ...fields });
    };
    let trimResult2 = v12.trim();
    if (!trimResult2 || trimResult2.startsWith("#") || trimResult2.startsWith("//")) {
      continue;
    }
    trimResult2 = stripWxHints(trimResult2);
    if (!trimResult2) {
      continue;
    }
    if (isNoiseLine(trimResult2)) {
      continue;
    }
    if (/----/.test(trimResult2)) {
      const mapResult = trimResult2.split(/----+/).map(arg1 => arg1.trim());
      if (mapResult.length === 3 && mapResult[0] && mapResult[1] && mapResult[2]) {
        if (includeDiagnostics) unrecognizedLines.push(lineNumber);
        arr4.push({
          username: mapResult[0],
          password: mapResult[1],
          totpSecret: mapResult[2]
        });
        continue;
      }
    }
    if (ABSOLUTE_URL_RE.test(trimResult2)) {
      try {
        const inner = unwrapPastedSecret(trimResult2);
        addLine({
          type: "token",
          raw: inner
        });
      } catch {
        // Keep the URL so import-text reports failed (ERR_NO_TOKEN_IN_INPUT)
        // instead of added=0 skipped=0 failed=0.
        addLine({
          type: "token",
          raw: trimResult2
        });
      }
      continue;
    }
    if (looksLikeToken(trimResult2)) {
      addLine({
        type: "token",
        raw: trimResult2
      });
      continue;
    }
    if (trimResult2.startsWith("{") && trimResult2.endsWith("}")) {
      try {
        const parseResult = JSON.parse(trimResult2);
        const v13 = parseResult.email || parseResult.username || parseResult.account || parseResult.user || parseResult.mail || parseResult.login;
        const v22 = parseResult.password || parseResult.pass || parseResult.pwd || parseResult.passwd || parseResult.secret;
        if (v13 && v22 && isValidEmail(String(v13).trim())) {
          addLine({
            type: "pair",
            email: String(v13).trim(),
            password: String(v22).trim()
          });
          continue;
        }
        const v32 = parseResult.token || parseResult.sessionToken || parseResult.session_token || parseResult.authToken || parseResult.access_token;
        if (v32) {
          addLine({
            type: "token",
            raw: String(v32).trim()
          });
          continue;
        }
      } catch (err) {}
    }
    const matchResult = trimResult2.match(RE_LABEL_PASS);
    if (matchResult) {
      const trimResult3 = trimResult2.substring(matchResult[0].length).trim();
      if (trimResult3) {
        if (ABSOLUTE_URL_RE.test(trimResult3)) {
          try {
            addLine({
              type: "token",
              raw: unwrapPastedSecret(trimResult3)
            });
          } catch {
            addLine({
              type: "token",
              raw: trimResult3
            });
          }
        } else if (looksLikeToken(trimResult3)) {
          addLine({
            type: "token",
            raw: trimResult3
          });
        } else {
          addLine({
            type: "pass",
            password: trimResult3
          });
        }
        continue;
      }
      unrecognizedLines.push(lineNumber);
      continue;
    }
    const matchResult2 = trimResult2.match(RE_LABEL_EMAIL);
    if (matchResult2) {
      const trimResult3 = trimResult2.substring(matchResult2[0].length).trim();
      if (isValidEmail(trimResult3)) {
        addLine({
          type: "email",
          email: trimResult3
        });
        continue;
      }
      trimResult2 = trimResult3 || trimResult2;
    }
    const parsesinglelineResult = parseSingleLine(trimResult2);
    if (parsesinglelineResult) {
      addLine({
        type: "pair",
        email: parsesinglelineResult.email,
        password: parsesinglelineResult.password
      });
      continue;
    }
    if (isValidEmail(trimResult2)) {
      addLine({
        type: "email",
        email: trimResult2
      });
      continue;
    }
    if (trimResult2.length >= 40 && /^[A-Za-z0-9_\-\.\$\/+=]+$/.test(trimResult2) && !trimResult2.includes("@")) {
      addLine({
        type: "token",
        raw: trimResult2
      });
      continue;
    }
    unrecognizedLines.push(lineNumber);
  }
  let pendingEmail = null;
  let pendingPassword = null;
  let pendingToken = null;
  const recordUnpaired = item => { if (item) unrecognizedLines.push(item.lineNumber); };
  for (const item of arr5) {
    if (item.type === "pair") {
      if (item.email && item.password && isValidEmail(item.email)) {
        arr.push({
          email: item.email,
          password: item.password
        });
      }
      recordUnpaired(pendingEmail);
      recordUnpaired(pendingPassword);
      pendingEmail = null;
      pendingPassword = null;
    } else if (item.type === "email") {
      recordUnpaired(pendingEmail);
      if (pendingToken) {
        arr3.push({
          email: item.email,
          token: pendingToken.raw
        });
        pendingToken = null;
        pendingEmail = null;
      } else if (pendingPassword) {
        arr.push({
          email: item.email,
          password: pendingPassword.password
        });
        pendingPassword = null;
        pendingEmail = null;
      } else {
        pendingEmail = item;
      }
    } else if (item.type === "pass") {
      if (pendingEmail) {
        arr.push({
          email: pendingEmail.email,
          password: item.password
        });
        pendingEmail = null;
      } else {
        recordUnpaired(pendingPassword);
        pendingPassword = item;
      }
    } else if (item.type === "token") {
      if (item.raw) {
        if (pendingEmail) {
          arr3.push({
            email: pendingEmail.email,
            token: item.raw
          });
          pendingEmail = null;
        } else {
          if (pendingToken) {
            arr2.push(pendingToken.raw);
          }
          pendingToken = item;
        }
      }
    }
  }
  if (pendingToken) {
    arr2.push(pendingToken.raw);
  }
  recordUnpaired(pendingEmail);
  recordUnpaired(pendingPassword);
  unrecognizedLines.sort((a, b) => a - b);
  return {
    accounts: arr,
    tokens: arr2,
    tokenPairs: arr3,
    githubAccounts: arr4,
    ...(includeDiagnostics ? { unrecognizedLines } : {})
  };
}
// Pull a token out of a show-auth-token / OAuth redirect URL. Bare strings
// pass through. A URL with no token query/hash throws ERR_NO_TOKEN_IN_INPUT
// so POST /accounts does not send the whole URL to RegisterUser (#257).
//
// Any absolute scheme counts, not just http(s): the desktop app's callback is
// `windsurf://codeium.windsurf?access_token=…` and it used to be handed to
// RegisterUser verbatim as an 88-char "token" (F4).
function unwrapPastedSecret(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (!ABSOLUTE_URL_RE.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const pick = (params) => (params.get('access_token') || params.get('token') || params.get('auth_token') || '').trim();
    const fromQuery = pick(u.searchParams);
    if (fromQuery) return fromQuery;
    const frag = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
    if (frag) {
      const fromHash = pick(new URLSearchParams(frag));
      if (fromHash) return fromHash;
    }
  } catch (e) {
    if (e && e.code === 'ERR_NO_TOKEN_IN_INPUT') throw e;
  }
  const err = new Error('ERR_NO_TOKEN_IN_INPUT');
  err.code = 'ERR_NO_TOKEN_IN_INPUT';
  throw err;
}

function classifyToken(arg1) {
  const trimResult = (arg1 || "").trim();
  if (!trimResult) {
    return "unknown";
  }
  if (trimResult.startsWith("devin-session-token$")) {
    return "session";
  }
  if (trimResult.startsWith("auth1_") && trimResult.length >= 20) {
    return "auth1";
  }
  if (trimResult.length > 100 && !trimResult.includes(" ") && !trimResult.includes("@") && !trimResult.startsWith("devin-") && !trimResult.startsWith("auth1_")) {
    return "refresh";
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimResult) && trimResult.length > 100) {
    return "refresh";
  }
  return "unknown";
}

export { parseAccountText, isValidEmail, looksLikeToken, classifyToken, unwrapPastedSecret };

// Whitelabel: decode a devin-session-token$<JWT> payload to harvest email/exp
// without any network call (ported from devinSessionImporter.js). auth1_ tokens
// are not JWTs → returns nulls.
export function parseDevinJwtPayload(t) {
  const o = { email: null, sub: null, exp: null };
  if (!t || typeof t !== 'string') return o;
  let v = t;
  if (t.startsWith('devin-session-token$')) v = t.slice('devin-session-token$'.length);
  else if (t.startsWith('auth1_')) return o;
  const s = v.split('.'); if (s.length < 2) return o;
  try {
    let b = s[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return { email: typeof p.email === 'string' ? p.email : null,
             sub: typeof p.sub === 'string' ? p.sub : null,
             exp: typeof p.exp === 'number' ? p.exp : null };
  } catch { return o; }
}
