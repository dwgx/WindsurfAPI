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
  return (
    /\b(?:I'll|I will|Let me|I need to)\s+(?:first\s+)?(?:read|check|inspect|calculate|compute|run|call|look|search|verify|open|fetch|discover)\b/i.test(
      t,
    ) ||
    /(?:읽|확인|실행|계산|조회|검사|검색).{0,20}(?:하겠습니다|겠습니다|할게요)[.!。]?$/u.test(
      t,
    )
  );
}
