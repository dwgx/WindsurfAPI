/**
 * Cascade replayed-history image counters — in-memory, lifetime-of-process.
 *
 * WHY: a Cascade request replays the caller's history as ONE text blob
 * (SendUserCascadeMessage field 2) and carries images as a flat, message-level
 * repeated field (6). Images from earlier turns used to reach the model as the
 * literal placeholder "[Image omitted from text history]" with no signal
 * anywhere — an operator could not tell a text-only conversation from one that
 * silently lost vision context. These counters make the attach/drop decision
 * queryable (dashboard /connect-metrics → `cascadeImages`) instead of grep-only.
 *
 * Deliberately NOT persisted: they are health/rate signals, not billing — a
 * restart resetting them is correct ("since this process started"). The module
 * imports nothing so it can never create a cycle with config/client/dashboard.
 */

const _counters = {
  // historical images that made it onto the wire (field 6) in a replayed history
  cascade_image_history_attached: 0,
  // historical images (and image-like blocks) that did not ride the wire
  cascade_image_history_dropped: 0,
  // current-turn images that did not fit the shared field-6 budget (G08:
  // the caps bound the WHOLE image list, not just replayed history)
  cascade_image_current_dropped: 0,
};

export function bumpCascadeImage(name, n = 1) {
  if (Object.prototype.hasOwnProperty.call(_counters, name)) _counters[name] += n;
}

export function getCascadeImageMetrics() {
  return { ..._counters };
}

export function resetCascadeImageMetrics() {
  for (const k of Object.keys(_counters)) _counters[k] = 0;
}
