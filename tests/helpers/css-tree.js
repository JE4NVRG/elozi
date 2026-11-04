// Minimal CSS reader for the layer guards (FRONTEND-V2 §3.1). Not a full parser: it skips comments,
// respects strings and parentheses, and returns a tree of { prelude, children } blocks and
// { prelude, statement } items (declarations and at-rule statements such as `@layer a, b;`).
const BACKSLASH = String.fromCharCode(92);

function endOfString(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) index += source[index] === BACKSLASH ? 2 : 1;
  return index + 1;
}

/** Source without comments (strings are kept, so a `/*` inside quotes survives). */
export function stripCssComments(css) {
  let output = '', index = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      index = end < 0 ? css.length : end + 2;
      output += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      const end = endOfString(css, index);
      output += css.slice(index, end);
      index = end;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

/** Tree of the stylesheet. Throws on a stray `}` or an unclosed block, which would leak rules out of a layer. */
export function parseCss(css) {
  const source = stripCssComments(css);
  let index = 0;
  const readBlock = nested => {
    const items = [];
    let prelude = '', parentheses = 0;
    const flush = () => { if (prelude.trim()) items.push({ prelude: prelude.trim().replace(/\s+/g, ' '), statement: true }); prelude = ''; };
    while (index < source.length) {
      const char = source[index];
      if (char === '"' || char === "'") {
        const end = endOfString(source, index);
        prelude += source.slice(index, end);
        index = end;
        continue;
      }
      if (char === '(') parentheses++;
      if (char === ')') parentheses = Math.max(0, parentheses - 1);
      if (char === '{' && !parentheses) {
        index++;
        const head = prelude.trim().replace(/\s+/g, ' ');
        prelude = '';
        items.push({ prelude: head, children: readBlock(true) });
        continue;
      }
      if (char === '}' && !parentheses) {
        if (!nested) throw new Error(`"}" sem bloco aberto na posição ${index}`);
        index++;
        flush();
        return items;
      }
      if (char === ';' && !parentheses) {
        index++;
        flush();
        continue;
      }
      prelude += char;
      index++;
    }
    if (nested) throw new Error('bloco sem "}" até o fim do arquivo');
    flush();
    return items;
  };
  return readBlock(false);
}

const isDeclarationBlock = item => item.children && item.children.every(child => !child.children);

/** Declarations of a { prelude, children } block: [{ property, value, important }]. */
export function declarationsOf(item) {
  return item.children.filter(child => child.statement && child.prelude.includes(':')).map(child => {
    const colon = child.prelude.indexOf(':');
    const raw = child.prelude.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(raw);
    return { property: child.prelude.slice(0, colon).trim().toLowerCase(), value: raw.replace(/!\s*important\s*$/i, '').trim(), important };
  });
}

/** Every declaration block (style rule, @font-face, keyframe) with the chain of enclosing at-rules. */
export function cssRules(items, context = []) {
  const list = [];
  for (const item of items) {
    if (!item.children) continue;
    if (isDeclarationBlock(item) && !/^@(?:media|supports|layer|container|scope|document)\b/i.test(item.prelude)) list.push({ selector: item.prelude, context, declarations: declarationsOf(item) });
    else list.push(...cssRules(item.children, [...context, item.prelude]));
  }
  return list;
}
