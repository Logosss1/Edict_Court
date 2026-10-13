// `@mcp:<server>/<uri>` resource references typed into an edict (the composer's @ picker inserts them; submit()
// reads each resource and appends its text). A URI with spaces, CJK text or trailing punctuation is written
// in angle brackets: `@mcp:<server>/<uri with spaces>`.

/** Characters that end a bare reference: whitespace, CJK ideographs, CJK / fullwidth punctuation. */
const STOP = '\\s<>\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
export const MCP_REF_RE = new RegExp(`@mcp:([\\w.-]{1,48})\\/(?:<([^<>\\n]{1,4096})>|([^${STOP}]{1,4096}))`, 'g');
/** Sentence punctuation right after a bare reference is not part of the URI. */
const TRAILING = /[.,;:!?)\]}'"`]+$/;

export interface McpRef { server: string; uri: string }

/** Distinct references in order of appearance. */
export function findMcpRefs(text: string): McpRef[] {
  const out: McpRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MCP_REF_RE)) {
    const uri = (m[2] ?? m[3].replace(TRAILING, '')).trim();
    const key = `${m[1]}\n${uri}`;
    if (!uri || seen.has(key)) continue;
    seen.add(key);
    out.push({ server: m[1], uri });
  }
  return out;
}

/** The token the composer inserts for a resource (bracketed when a bare URI would not survive parsing). */
export function mcpRefToken(server: string, uri: string): string {
  const bare = `@mcp:${server}/${uri}`;
  const back = findMcpRefs(bare);
  return back.length === 1 && back[0].uri === uri && bare.match(MCP_REF_RE)?.[0] === bare ? bare : `@mcp:${server}/<${uri}>`;
}
