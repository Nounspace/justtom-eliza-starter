export function formatValue(v: any): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(formatValue).join(", ") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter(k => isNaN(Number(k)));
    if (keys.length)
      return `{ ${keys.map(k => `${k}: ${formatValue(v[k])}`).join(", ")} }`;
    return JSON.stringify(v);
  }
  return String(v);
}
