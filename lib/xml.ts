// XML entity handling for the providers that speak XML (S3, R2, Azure).
// Servers escape file keys in list responses, and the S3/R2 DeleteObjects
// body must escape them back; without both sides, keys containing "&" or "<"
// end up with the wrong path or break the batch delete.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function extractTags(xmlStr: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xmlStr)) !== null) results.push(match[1]);
  return results;
}

export function getTag(xmlStr: string, tag: string): string {
  return extractTags(xmlStr, tag)[0] ?? "";
}

export const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? all;
  });
