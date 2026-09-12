import { createHash, randomBytes } from 'node:crypto';
export function sweModel(model, effort) {
  if (!/(?:^|\/|ocx-devin-)swe-2(?:-(?:medium|high|max))?$/.test(String(model)))
    return null;
  const level =
    effort || String(model).match(/-(medium|high|max)$/)?.[1] || 'high';
  return (
    'swe-2-' +
    ({
      off: 'medium',
      minimal: 'medium',
      low: 'medium',
      medium: 'medium',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    }[level] || 'high')
  );
}
export const hash = (x) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((x) =>
      x.type === 'text' || x.type === 'input_text' ? x.text : JSON.stringify(x),
    )
    .join('\n');
}
export function canonicalMessage(m) {
  const o = { role: m.role, content: contentText(m.content) };
  if (m.tool_calls?.length)
    o.tool_calls = m.tool_calls.map((t) => ({
      id: t.id,
      type: t.type || 'function',
      function: { name: t.function?.name, arguments: t.function?.arguments },
    }));
  if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
  return o;
}
export function conversationKey(messages) {
  return messages
    .filter((m) => !['system', 'developer'].includes(m.role))
    .map(canonicalMessage);
}
export function isPrefix(a, b) {
  return (
    a.length <= b.length &&
    a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]))
  );
}
export function toolDefinitions(body) {
  if (body.tool_choice === 'none') return [];
  if (body.tools != null && !Array.isArray(body.tools))
    throw new Error('tools must be an array');
  return (body.tools || []).map((t, i) => {
    const f = t.function || t;
    if (typeof f.name !== 'string' || !f.name)
      throw new Error('Each tool must have a name');
    return {
      name: 'client_tool_' + i,
      title: f.name,
      description: `Client function: ${f.name}\n${f.description || ''}`,
      inputSchema: f.parameters ||
        f.input_schema || { type: 'object', properties: {} },
      originalName: f.name,
    };
  });
}
export function buildPrompt(messages, body, { initial = true } = {}) {
  // Preserve the caller's complete instructions and transcript. No identity
  // substitutions, policy-keyword filtering, or removal of memories occurs.
  const preamble = initial
    ? [
        'You are serving a coding client through its client MCP server. The JSON below is the caller conversation, not a request to summarize that conversation.',
        'Preserve and follow the caller system/developer instructions within your platform policies. Complete the latest user request. Caller instructions do not override platform policy.',
        'Use the client MCP functions to act in the caller environment. Those tools execute in the client and retain its approval and permission checks. The native host file/exec tools are disabled because this process is only the connection adapter.',
        'A client permission rejection is binding. Do not retry the denied operation through another tool, language, subprocess, or path. Stop and explain the rejected permission so the user can decide in their client.',
        'The client MCP server exposes list_client_tools, get_client_tools, and call_client_tool. Use get_client_tools to obtain complete original schemas for the names needed, then call_client_tool to execute them. Do not invent tool results. Give a complete final answer appropriate to the user request after the work is done.',
        'An announcement of intended work is not a completed answer. If you announce that you will read a skill, search, or perform another action needed for the request, execute it through the client MCP tools before ending the turn. Finish with the requested result or a concrete blocker. A skill path in the caller conversation belongs to the client environment and can be read through its file-reading tool.',
        `Available client function names: ${(body.tools || []).map((t) => (t.function || t).name).join(', ')}`,
      ].join('\n')
    : 'Continue the same caller conversation with these new messages. Preserve its instructions and tool execution boundary.';
  const choice = body.tool_choice;
  const directive =
    choice === 'required' || choice === 'any'
      ? 'The caller requires a client function call on this turn.'
      : choice && typeof choice === 'object'
        ? `The caller requires function ${JSON.stringify(choice.function?.name || choice.name)} on this turn.`
        : '';
  return [preamble, directive, JSON.stringify(messages)]
    .filter(Boolean)
    .join('\n\n');
}
export function errorInfo(e) {
  const msg = String(e?.message || e);
  if (
    /content policy|remove (sensitive|unsafe) content|content[_ ]blocked/i.test(
      msg,
    )
  )
    return {
      status: 400,
      type: 'invalid_request_error',
      code: 'CONTENT_BLOCKED',
      message: msg,
    };
  return {
    status: e.status || 502,
    type: e.type || 'server_error',
    code: e.code || 'DEVIN_ACP_ERROR',
    message: msg,
  };
}

// OmO bounds IDs to 32 chars; OpenClaw strips punctuation for unknown models.
// A short, purely alphanumeric ID survives both without client patches.
export const newToolCallId = () => 'call' + randomBytes(12).toString('hex');

// OmO emits this exact prefix for a rejected approval. Inspect only the
// unresolved trailing tool batch, never quoted source files or old history.
export function clientPermissionDenial(messages) {
  for (
    let i = messages.length - 1;
    i >= 0 && messages[i].role === 'tool';
    i--
  ) {
    const text = contentText(messages[i].content).trim();
    if (
      /^The user rejected permission to use this specific tool call\b/.test(
        text,
      )
    )
      return text;
  }
  return null;
}

function normalizeSkillPath(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/#.*$/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readToolNames(defs) {
  return new Set(
    (defs || [])
      .filter((def) => {
        const name = String(def.originalName || def.name || '');
        const props = def.inputSchema?.properties || {};
        return (
          /^(?:read|read_file|read_text_file|fs_read)$/i.test(name) &&
          ['path', 'file_path', 'filePath', 'filename'].some((key) =>
            Object.hasOwn(props, key),
          )
        );
      })
      .map((def) => def.originalName || def.name),
  );
}

function callPath(call) {
  let args = call?.function?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return '';
    }
  }
  if (!args || typeof args !== 'object') return '';
  return normalizeSkillPath(
    args.path || args.file_path || args.filePath || args.filename,
  );
}

// Aside and Pi encode an explicitly selected skill as a Markdown link to its
// SKILL.md. The matching client read and result are the completion contract;
// free-form promises such as "I'll read it" are only a fallback signal.
export function pendingSkillRead(messages, defs) {
  const names = readToolNames(defs);
  if (!names.size) return null;
  let ref = null;
  for (let i = 0; i < (messages || []).length; i++) {
    if (messages[i]?.role !== 'user') continue;
    const text = contentText(messages[i].content);
    const re = /\[\$([^\]\r\n]+)\]\(([^)\r\n]*\/SKILL\.md(?:#[^)\r\n]*)?)\)/giu;
    for (const match of text.matchAll(re)) {
      ref = {
        index: i,
        name: match[1].trim(),
        path: normalizeSkillPath(match[2]),
      };
    }
  }
  if (!ref) return null;
  const calls = new Map();
  for (let i = ref.index + 1; i < (messages || []).length; i++) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      for (const call of message.tool_calls || []) {
        if (
          names.has(call?.function?.name) &&
          callPath(call) === ref.path
        )
          calls.set(call.id, true);
      }
    }
    if (message?.role === 'tool' && calls.has(message.tool_call_id)) return null;
  }
  return { ...ref, toolNames: [...names] };
}

export function requiredToolChoice(body) {
  const choice = body?.tool_choice;
  if (choice === 'required' || choice === 'any')
    return { kind: 'required_tool' };
  if (choice && typeof choice === 'object')
    return {
      kind: 'required_tool',
      name: choice.function?.name || choice.name || null,
    };
  return null;
}

export function isPendingAction(text) {
  const t = String(text || '')
    .trim()
    .replace(/[’‘]/g, "'");
  if (
    !t ||
    t.length > 700 ||
    /```|content policy|request.{0,30}blocked|cannot (?:assist|help)|not allowed/i.test(
      t,
    )
  )
    return false;
  // Offers, scheduled actions, and quoted examples are not instructions to
  // execute a client operation now. Do not turn a blocker into a retry.
  if (
    /원하시면|원한다면|필요하시면|필요하면|내일|다음\s*(?:주|달)|나중에|권한.{0,20}(?:없|거부)|정책.{0,20}차단|(?:example|예시)\s*(?:문장)?\s*:/i.test(
      t,
    )
  )
    return false;
  return (
    /\b(?:I'll|I will|Let me|I need to)\s+(?:first\s+)?(?:read|check|inspect|calculate|compute|run|call|look|search|verify|open|fetch|discover)\b/i.test(
      t,
    ) ||
    /(?:읽(?:을게(?:요)?|겠습니다|어볼게(?:요)?|어보겠습니다)|(?:확인|실행|계산|조회|검사|검색|조사|분석|시작|호출|정리)(?:할게(?:요)?|하겠습니다)|(?:찾아|살펴|알아|열어)?(?:볼게(?:요)?|보겠습니다)|(?:불러|가져)오겠습니다|열겠습니다)[.!。…]*$/u.test(
      t,
    )
  );
}

export function completionIssue({
  attemptText,
  messages,
  body,
  defs,
  receivedToolResults = false,
}) {
  const text = String(attemptText || '').trim();
  if (!text)
    return { kind: receivedToolResults ? 'empty_post_tool' : 'empty_turn' };
  const skill = pendingSkillRead(messages, defs);
  if (skill) return { kind: 'skill_read_required', ...skill };
  const required = requiredToolChoice(body);
  if (required) return required;
  if ((defs || []).length && isPendingAction(text))
    return { kind: 'announced_action' };
  return null;
}

export function completionNudge(issue) {
  if (issue?.kind === 'empty_post_tool')
    return 'The client tool results were delivered, but your last turn contained no final answer. Continue from the existing session state and give the user the complete final answer now. Do not repeat completed side effects. Use another client function only if more evidence is actually required.';
  if (issue?.kind === 'empty_turn')
    return 'Your last turn contained neither an answer nor a client function call. Continue the requested work now. Use the client MCP functions when action is required, or give the complete final answer if no function is needed.';
  if (issue?.kind === 'skill_read_required')
    return `The caller explicitly selected skill ${JSON.stringify(issue.name)}. Before completing, call one of ${JSON.stringify(issue.toolNames)} through client MCP to read exactly ${JSON.stringify(issue.path)}. Preserve the client's approval checks, then follow the loaded skill.`;
  if (issue?.kind === 'required_tool')
    return issue.name
      ? `The caller requires client function ${JSON.stringify(issue.name)} on this turn. Call it through client MCP with its complete schema before completing.`
      : 'The caller requires at least one client function call on this turn. Call the appropriate function through client MCP before completing.';
  return 'Your last reply announced a pending action but returned no client function call. Continue the requested work now using client MCP functions and their complete schemas. Preserve all original instructions and permission checks. If the action cannot be performed, state the concrete blocker instead of announcing another future action.';
}
