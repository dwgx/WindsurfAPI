// A diagnostic for a client-owned tool call. Lengths are UTF-16 code units,
// available without copying or traversing the original patch or error string.
const MAX_INSPECT_UNITS = 16 * 1024;
const MAX_SAMPLES = 16;
const samples = [];
let calls = 0;

function isBarePatch(value) {
  const text = value.trim();
  const first = text.indexOf('\n');
  const last = text.lastIndexOf('\n');
  return first >= 0 && text.slice(0, first).trimEnd() === '*** Begin Patch' &&
    text.slice(last + 1) === '*** End Patch';
}

function shape(value) {
  if (typeof value !== 'string') return 'absent';
  if (value.length > MAX_INSPECT_UNITS) return 'over_limit';
  if (isBarePatch(value)) return 'bare_patch';
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.input === 'string' && isBarePatch(parsed.input)) return 'json_input_patch';
    return 'json_other';
  } catch { return 'non_json'; }
}

const units = value => typeof value === 'string' ? value.length : null;

export function observeApplyPatch(name, args, invalid, source) {
  if (name !== 'apply_patch') return;
  const invalidText = invalid?.str;
  if (samples.length === MAX_SAMPLES) samples.shift();
  samples.push({
    source: source === 'native' ? 'native' : 'emulated',
    argumentShape: shape(args), argumentUnits: units(args),
    invalidShape: shape(invalidText), invalidUnits: units(invalidText),
    invalidErrorUnits: units(invalid?.err),
  });
  calls++;
}

export function getApplyPatchDiagnostics() {
  return { calls, sampleLimit: MAX_SAMPLES, inspectionLimitUnits: MAX_INSPECT_UNITS,
    recent: samples.map(sample => ({ ...sample })) };
}

export function resetApplyPatchDiagnostics() {
  samples.length = 0;
  calls = 0;
}
