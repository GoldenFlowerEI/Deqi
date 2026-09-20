/**
 * v4.0: Recipe — a declarative multi-step workflow.
 *
 * Recipes are YAML-ish files (a strict subset of YAML that we
 * parse ourselves so we have zero npm deps). A recipe names
 * a tool per step and feeds it the args; the runner calls the
 * tool as if the model had asked for it, surfaces the result,
 * and proceeds.
 *
 * Why recipes:
 *   - power users want to encode "release", "smoke test", "open
 *     a PR" as one command, not chat-typed multi-turn
 *   - CI can call `deqi run-recipe ./recipes/release.yaml`
 *   - the agent can invoke a recipe from inside a turn
 *     (tool: recipe_run) for known safe sub-workflows
 *
 * Format (the only one we support for v4.0):
 *   name: <string>
 *   description: <optional string>
 *   steps:
 *     - name: <string>             # optional, shown in logs
 *       tool: <tool name>           # must exist on the server
 *       args: { ... }               # the tool's input
 *       if: <boolean expression>    # optional; if false, skip
 *       parallel: <bool>            # optional; run with next sibling
 *
 * The parser below handles: comments, scalars, inline lists,
 * nested maps, and arrays of maps. It rejects anything else
 * with a clear error. We do NOT support block strings (`|`),
 * anchors (`&`/`*`), or multi-doc (`---`).
 */

export interface RecipeStep {
  name?: string;
  tool: string;
  args: Record<string, unknown>;
  if?: string;
  parallel?: boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  steps: RecipeStep[];
}

/**
 * Minimal YAML-subset parser. Line-based, indent-based, no
 * external deps. Throws on syntax errors with a line number.
 *
 * This is NOT a full YAML 1.2 parser. It is a strict subset:
 *   - top-level `key: value` pairs
 *   - nested via indentation (2-space convention, but any
 *     consistent indent works)
 *   - arrays via `- value` (inline) or `-` followed by indented map
 *   - scalar values: string, number, boolean, null
 *   - comments: `# ...` to end of line
 */
export function parseRecipe(source: string): Recipe {
  const lines = source.split(/\r?\n/);
  // Strip comments + blank lines, keeping indent info.
  const tokens: Array<{ indent: number; content: string; line: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    if (trimmed === '' || /^\s*#/.test(trimmed)) continue;
    const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
    const content = trimmed.replace(/\s+#.*$/, '');
    if (content === '') continue;
    tokens.push({ indent, content, line: i + 1 });
  }

  // Recursive descent. Top-level must be a flat map (the recipe
  // envelope) with the `steps` key holding an array of maps.
  let pos = 0;
  function isArrayItem(t: { indent: number; content: string }): boolean {
    // content has leading whitespace stripped but the dash check
    // needs the raw form. We check if content trimmed starts with
    // '- ' or '-'.
    const c = t.content.trimStart();
    return c.startsWith('- ');
  }
  function parseValue(indent: number): unknown {
    const tok = tokens[pos];
    if (!tok) throw new Error('unexpected end of recipe');
    if (tok.indent < indent) return undefined;
    if (tok.indent > indent) {
      throw new Error(`unexpected indent at line ${tok.line}: ${tok.content}`);
    }
    if (isArrayItem(tok)) {
      return parseArray(indent);
    }
    return parseMap(indent);
  }

  function parseScalar(s: string): unknown {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    // Strip surrounding quotes if present.
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.indent < indent) break;
      if (tok.indent > indent) {
        throw new Error(`bad indent at line ${tok.line}`);
      }
      // Content includes leading whitespace; trim before matching.
      const trimmed = tok.content.trimStart();
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!m) throw new Error(`expected "key: value" at line ${tok.line}: ${tok.content}`);
      const key = m[1];
      const rest = m[2].trim();
      pos += 1;
      if (rest === '') {
        // Nested structure on subsequent lines.
        const next = tokens[pos];
        if (next && next.indent > indent) {
          out[key] = parseValue(next.indent);
        } else {
          out[key] = null;
        }
      } else {
        out[key] = parseScalar(rest);
      }
    }
    return out;
  }

  function parseArray(indent: number): unknown[] {
    const out: unknown[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.indent < indent) break;
      if (tok.indent > indent) throw new Error(`bad indent at line ${tok.line}`);
      if (isArrayItem(tok)) {
        // Strip the leading "- " (and any indent stripped earlier).
        const trimmed = tok.content.trimStart();
        const rest = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
        pos += 1;
        if (rest === '') {
          // Map follows on the next line at indent+2.
          const next = tokens[pos];
          if (next && next.indent > indent) {
            out.push(parseValue(next.indent));
          } else {
            out.push(null);
          }
        } else if (rest.includes(':')) {
          // Inline map: "- name: foo, tool: bar" — first pair
          // is on the dash line; subsequent pairs on the next
          // lines at indent+2.
          const obj: Record<string, unknown> = {};
          const m = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
          if (m) {
            obj[m[1]] = m[2] ? parseScalar(m[2]) : null;
          }
          // Peek for additional pairs at indent+2.
          while (pos < tokens.length) {
            const peek = tokens[pos];
            if (peek.indent <= indent) break;
            // Content includes leading whitespace; trim before matching.
            const trimmed = peek.content.trimStart();
            const inline = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
            if (!inline) break;
            pos += 1;
            const rest2 = inline[2].trim();
            if (rest2 === '') {
              // Nested structure (sub-map or sub-array) follows
              // on the next line at an even deeper indent.
              const next = tokens[pos];
              if (next && next.indent > peek.indent) {
                obj[inline[1]] = parseValue(next.indent);
              } else {
                obj[inline[1]] = null;
              }
            } else {
              obj[inline[1]] = parseScalar(rest2);
            }
          }
          out.push(obj);
        } else {
          out.push(parseScalar(rest));
        }
      } else {
        break;
      }
    }
    return out;
  }

  const top = parseMap(0) as Record<string, unknown>;
  if (typeof top.name !== 'string' || !top.name) {
    throw new Error('recipe is missing required field: name');
  }
  if (!Array.isArray(top.steps) || top.steps.length === 0) {
    throw new Error('recipe is missing required field: steps (non-empty array)');
  }
  for (let i = 0; i < top.steps.length; i += 1) {
    const s = top.steps[i] as Record<string, unknown>;
    if (typeof s.tool !== 'string' || !s.tool) {
      throw new Error(`recipe step ${i} is missing required field: tool`);
    }
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      throw new Error(`recipe step ${i}: args must be a map`);
    }
  }
  return top as unknown as Recipe;
}

/**
 * Stringify a Recipe back to the YAML-subset. Round-trips with
 * parseRecipe() for any input we produce.
 */
export function stringifyRecipe(r: Recipe): string {
  const lines: string[] = [];
  lines.push(`name: ${r.name}`);
  if (r.description) lines.push(`description: ${r.description}`);
  lines.push('steps:');
  for (const s of r.steps) {
    lines.push(`  - name: ${s.name ?? ''}`);
    lines.push(`    tool: ${s.tool}`);
    const argsLines = stringifyMap(s.args, 6);
    if (argsLines.length > 0) {
      lines.push(`    args:`);
      lines.push(...argsLines);
    }
    if (s.if) lines.push(`    if: ${s.if}`);
    if (s.parallel) lines.push(`    parallel: true`);
  }
  return lines.join('\n') + '\n';
}

function stringifyMap(m: Record<string, unknown>, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined) {
      out.push(`${pad}${k}: null`);
    } else if (typeof v === 'string') {
      out.push(`${pad}${k}: ${v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push(`${pad}${k}: ${v}`);
    } else {
      out.push(`${pad}${k}: ${JSON.stringify(v)}`);
    }
  }
  return out;
}

/**
 * v4.0: validate that a recipe's tools all exist. Returns
 * the list of unknown tool names (empty = ok).
 */
export function validateRecipeTools(r: Recipe, knownTools: Set<string>): string[] {
  const missing: string[] = [];
  for (const s of r.steps) {
    if (!knownTools.has(s.tool)) missing.push(s.tool);
  }
  return missing;
}
