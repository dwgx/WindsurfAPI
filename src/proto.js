/**
 * Protobuf wire format codec — zero-dependency, schema-less.
 *
 * Wire types:
 *   0 = Varint    (int32, uint64, bool, enum)
 *   1 = Fixed64   (double, fixed64)
 *   2 = LenDelim  (string, bytes, embedded messages)
 *   5 = Fixed32   (float, fixed32)
 */

// ─── Varint ────────────────────────────────────────────────

export function encodeVarint(value) {
  const bytes = [];
  let v = Number(value);
  if (v < 0) {
    const big = BigInt(v) & 0xFFFFFFFFFFFFFFFFn;
    let b = big;
    for (let i = 0; i < 10; i++) {
      bytes.push(Number(b & 0x7Fn) | (i < 9 ? 0x80 : 0));
      b >>= 7n;
    }
    return Buffer.from(bytes);
  }
  // Use BigInt for values > 32 bits
  if (v > 0xFFFFFFFF) {
    let b = BigInt(v);
    while (b > 0n) {
      let byte = Number(b & 0x7Fn);
      b >>= 7n;
      if (b > 0n) byte |= 0x80;
      bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

export function decodeVarint(buf, offset = 0) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    if (shift < 28) {
      result |= (byte & 0x7F) << shift;
    } else {
      // Switch to BigInt for values requiring > 32 bits
      let big = BigInt(result);
      big |= BigInt(byte & 0x7F) << BigInt(shift);
      shift += 7;
      if (!(byte & 0x80)) return { value: Number(big), length: pos - offset };

      while (pos < buf.length) {
        const b = buf[pos++];
        big |= BigInt(b & 0x7F) << BigInt(shift);
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift >= 64) throw new Error('Varint overflow');
      }
      return { value: Number(big), length: pos - offset };
    }
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift >= 64) throw new Error('Varint overflow');
  }
  return { value: result >>> 0, length: pos - offset };
}

// ─── Field-level writers (standalone functions) ────────────

function makeTag(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

/** Write a varint field (wire type 0). */
export function writeVarintField(field, value) {
  return Buffer.concat([makeTag(field, 0), encodeVarint(value)]);
}

/** Write a length-delimited string field (wire type 2). */
export function writeStringField(field, str) {
  if (!str && str !== '') return Buffer.alloc(0);
  const data = Buffer.from(str, 'utf-8');
  return Buffer.concat([makeTag(field, 2), encodeVarint(data.length), data]);
}

/** Write a length-delimited bytes field (wire type 2). */
export function writeBytesField(field, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([makeTag(field, 2), encodeVarint(buf.length), buf]);
}

/** Write an embedded message field (wire type 2). */
export function writeMessageField(field, msgBuf) {
  if (!msgBuf || msgBuf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([makeTag(field, 2), encodeVarint(msgBuf.length), msgBuf]);
}

/** Write a fixed64 field (wire type 1). */
export function writeFixed64Field(field, buf8) {
  return Buffer.concat([makeTag(field, 1), buf8]);
}

/** Write a bool field (wire type 0), only if true. */
export function writeBoolField(field, value) {
  if (!value) return Buffer.alloc(0);
  return writeVarintField(field, 1);
}

// ─── Parser ────────────────────────────────────────────────

/**
 * Parse a protobuf buffer into an array of { field, wireType, value }.
 * For varint (0): value is a Number.
 * For lendelim (2): value is a Buffer (caller decides string vs message).
 * For fixed64 (1): value is an 8-byte Buffer.
 * For fixed32 (5): value is a 4-byte Buffer.
 */
export function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos += tag.length;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    let value;
    switch (wireType) {
      case 0: { // varint
        const v = decodeVarint(buf, pos);
        pos += v.length;
        value = v.value;
        break;
      }
      case 1: { // fixed64
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      }
      case 2: { // length-delimited
        const len = decodeVarint(buf, pos);
        pos += len.length;
        value = buf.subarray(pos, pos + len.value);
        pos += len.value;
        break;
      }
      case 5: { // fixed32
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wireType} at offset ${pos}`);
    }
    fields.push({ field: fieldNum, wireType, value });
  }
  return fields;
}

/** Get first field matching number and optional wire type. */
export function getField(fields, num, wireType) {
  return fields.find(f => f.field === num && (wireType === undefined || f.wireType === wireType)) || null;
}

/** Get all fields matching number. */
export function getAllFields(fields, num) {
  return fields.filter(f => f.field === num);
}
