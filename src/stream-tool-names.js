import { DEFAULT_MAX_QUEUED_BYTES } from './sse-framer.js';

// Chat names are deltas. A name that is both a declaration and a prefix cannot
// be put in an immutable output item until its suffix or a terminal frame arrives.
// Keep subsequent frames in wire order, including other tools and intervening text.
export class ToolNamePrefixBuffer {
  constructor(names, emit, limit = DEFAULT_MAX_QUEUED_BYTES) {
    this.names = [...new Set(names.filter(name => typeof name === 'string' && name))].sort();
    this.ambiguous = this.names.filter((name, i) => this.names[i + 1]?.startsWith(name));
    this.emit = emit;
    this.limit = limit;
    this.pending = new Map();
    this.resolved = new WeakSet();
    this.frames = [];
    this.bytes = 0;
  }

  write(chunk, size) {
    if (!this.ambiguous.length) return this.emit(chunk);
    if (chunk.error) {
      this.clear();
      return this.emit(chunk);
    }
    const frame = { chunk, size, waiting: 0 };
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const calls = choice?.delta?.tool_calls;
      for (const call of Array.isArray(calls) ? calls : []) {
        const fragment = call?.function?.name;
        if (typeof fragment !== 'string' || !fragment) continue;
        const key = (choice.index ?? 0) + ':' + (call.index ?? 0);
        const pending = this.pending.get(key);
        if (pending) {
          const previous = pending.fn.name;
          const joined = previous + fragment;
          if ((fragment.startsWith(previous) || previous.startsWith(fragment))
              && !this.names.some(name => name.startsWith(joined))) {
            pending.fn.name = fragment.length > previous.length ? fragment : previous;
          } else {
            pending.fn.name = joined;
          }
          delete call.function.name;
          if (!this.names.some(name => name !== pending.fn.name && name.startsWith(pending.fn.name))) {
            pending.frame.waiting--;
            this.pending.delete(key);
          }
        } else if (this.ambiguous.some(name => name.startsWith(fragment))) {
          this.pending.set(key, { fn: call.function, frame });
          this.resolved.add(call);
          frame.waiting++;
        }
      }
    }
    if (!this.frames.length && !frame.waiting) return this.emit(chunk);
    this.frames.push(frame);
    this.bytes += size;
    if (this.bytes > this.limit) {
      this.clear();
      return this.emit({ error: { type: 'upstream_error', message: 'Pending streamed tool names exceeded the buffer limit' } });
    }
    if (choices.some(choice => choice?.finish_reason)) return this.finish();
    let count = 0;
    while (count < this.frames.length && !this.frames[count].waiting) {
      const ready = this.frames[count++];
      this.bytes -= ready.size;
      this.emit(ready.chunk);
    }
    if (count) this.frames.splice(0, count);
  }

  finish() {
    const frames = this.frames;
    this.clear();
    for (const frame of frames) this.emit(frame.chunk);
  }

  clear() {
    this.pending.clear();
    this.frames = [];
    this.bytes = 0;
  }
}
