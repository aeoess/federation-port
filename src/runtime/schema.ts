import type { JsonSchema } from '../contract/types.ts'

/** Validates the JSON Schema subset declared in the contract. Returns error paths. */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errs: string[] = []
  if (schema.enum && !schema.enum.some(e => e === value)) errs.push(`${path}:enum`)
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [...errs, `${path}:type`]
      const obj = value as Record<string, unknown>
      for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${path}.${r}:required`)
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k]
        if (sub) errs.push(...validate(sub, v, `${path}.${k}`))
        else if (schema.additionalProperties === false) errs.push(`${path}.${k}:additional`)
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') errs.push(`${path}:type`)
      else if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}:pattern`)
      break
    case 'integer':
      if (!Number.isInteger(value)) errs.push(`${path}:type`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${path}:type`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${path}:type`)
      break
    case 'array':
      if (!Array.isArray(value)) errs.push(`${path}:type`)
      break
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errs.push(`${path}:minimum`)
  return errs
}
