/**
 * JSON canônico (I-25, research R-09): chaves ordenadas recursivamente (ordem de code unit, a mesma de
 * `Array.prototype.sort`), sem espaços; chaves com `undefined` são omitidas; arrays mantêm a ordem. Não depende da
 * ordem de inserção das chaves. O resultado é codificado em UTF-8 por quem calcula o hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError(`value of type ${typeof value} is not JSON-serializable`);
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
}
