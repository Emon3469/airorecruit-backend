import { z } from 'zod';

/**
 * Convert a Zod schema to the JSON Schema subset accepted by provider structured-output modes:
 * objects are closed (additionalProperties:false, all properties required) and numeric/length
 * constraints are dropped. Zod re-validates the full constraints on the way back in.
 */
const DROP_KEYS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'default',
]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = strictify(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return strictify(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })) as Record<string, unknown>;
}

/** Loose JSON Schema for tool parameters (keeps descriptions/enums, keeps optional fields optional). */
export function toToolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Pull the first JSON object out of a model response (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('No JSON object found in model output');
  }
}
