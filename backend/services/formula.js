// Safe formula language for computed custom fields.
//
// A computed field's `formula` is a single expression evaluated against the
// ticket context produced by cannedRender.buildContext() — i.e. the same
// inputs a canned response can pull: form inputs via {field.<slug>}, plus
// {ticket.*}, {submitter.*}, {assignee.*}, {actor.*}, {site.*}.
//
// NO eval / Function / property traversal: a hand-written tokenizer +
// recursive-descent parser feeds a tree-walking evaluator whose only callable
// surface is the whitelisted FUNCS table below. The worst a malicious formula
// can do is return a wrong string or throw.
//
// Grammar (lowest → highest precedence):
//   expr    := concat
//   concat  := compare ( '~' compare )*           // '~' = string concatenation
//   compare := add ( ('=='|'!='|'>='|'<='|'>'|'<') add )?
//   add     := mul ( ('+'|'-') mul )*             // numeric
//   mul     := unary ( ('*'|'/') unary )*         // numeric
//   unary   := '-' unary | primary
//   primary := NUMBER | STRING | REF | IDENT '(' args? ')' | '(' expr ')'
//   REF     := '{' ns '.' key '}'                 // resolved from context
//
// Examples (HR onboarding):
//   UPN     lower( slice({field.hr-first},0,1) ~ {field.hr-last} )            -> jdoe
//   G2 user lower( slice({field.hr-first},0,1) ~ {field.hr-last} )
//             ~ datepart({field.hr-dob},"M") ~ datepart({field.hr-dob},"D")   -> jdoe312
//   passwd  upper(slice({field.hr-first},0,1)) ~ lower(slice({field.hr-last},0,1))
//             ~ "^" ~ datepart({field.hr-dob},"MM") ~ datepart({field.hr-dob},"DD") ~ "#"  -> Jd^0312#
//   desked  "PC" ~ upper( if( len({field.hr-last})>=4,
//                             slice({field.hr-first},0,1) ~ slice({field.hr-last},0,4),
//                             slice({field.hr-first},0,5-len({field.hr-last})) ~ {field.hr-last} ) ) -> PCJODOE

// ───────────────────────── tokenizer ─────────────────────────

const TWO_CHAR_OPS = ['==', '!=', '>=', '<='];
const ONE_CHAR_OPS = ['~', '+', '-', '*', '/', '(', ')', ',', '>', '<'];

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // {ns.key} reference — key may contain hyphens (slug) / digits.
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw err(`unterminated { at ${i}`);
      const inner = src.slice(i + 1, end).trim();
      const dot = inner.indexOf('.');
      if (dot < 0) throw err(`reference "${inner}" must be {ns.key}`);
      toks.push({ t: 'ref', ns: inner.slice(0, dot).toLowerCase(), key: inner.slice(dot + 1).toLowerCase() });
      i = end + 1;
      continue;
    }
    // string literal
    if (c === '"' || c === "'") {
      let j = i + 1, out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) { out += src[j + 1]; j += 2; continue; }
        out += src[j++];
      }
      if (j >= n) throw err(`unterminated string at ${i}`);
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    // number
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // identifier (function name) — letters, digits, underscore
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw err(`unexpected character "${c}" at ${i}`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

function err(msg) {
  const e = new Error(`formula: ${msg}`);
  e.formula = true;
  return e;
}

// ───────────────────────── parser ─────────────────────────

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const eatOp = (v) => { const t = peek(); if (t.t === 'op' && t.v === v) { p++; return true; } return false; };

  function parseExpr() { return parseConcat(); }

  function parseConcat() {
    let left = parseCompare();
    while (peek().t === 'op' && peek().v === '~') { next(); left = { k: 'concat', a: left, b: parseCompare() }; }
    return left;
  }
  function parseCompare() {
    let left = parseAdd();
    const t = peek();
    if (t.t === 'op' && ['==', '!=', '>=', '<=', '>', '<'].includes(t.v)) {
      next();
      return { k: 'cmp', op: t.v, a: left, b: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      left = { k: 'arith', op, a: left, b: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v;
      left = { k: 'arith', op, a: left, b: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek().t === 'op' && peek().v === '-') { next(); return { k: 'neg', a: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'ref') return { k: 'ref', ns: t.ns, key: t.key };
    if (t.t === 'op' && t.v === '(') {
      const e = parseExpr();
      if (!eatOp(')')) throw err('expected )');
      return e;
    }
    if (t.t === 'ident') {
      if (!eatOp('(')) throw err(`"${t.v}" is not a value; functions need () — did you mean a {ref}?`);
      const args = [];
      if (!(peek().t === 'op' && peek().v === ')')) {
        args.push(parseExpr());
        while (eatOp(',')) args.push(parseExpr());
      }
      if (!eatOp(')')) throw err(`expected ) closing ${t.v}(`);
      return { k: 'call', name: t.v.toLowerCase(), args };
    }
    throw err(`unexpected ${t.t === 'eof' ? 'end of formula' : JSON.stringify(t.v)}`);
  }

  const tree = parseExpr();
  if (peek().t !== 'eof') throw err(`unexpected trailing ${JSON.stringify(peek().v)}`);
  return tree;
}

// ───────────────────────── helpers ─────────────────────────

const S = (v) => (v == null ? '' : String(v));
const N = (v) => {
  const n = typeof v === 'number' ? v : Number(S(v).trim());
  if (!Number.isFinite(n)) throw err(`"${v}" is not a number`);
  return n;
};
const truthy = (v) => {
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v !== 0;
  const s = S(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
};

function parseDate(v) {
  const s = S(v).trim();
  if (!s) throw err('empty date');
  // Plain YYYY-MM-DD / M/D/Y → anchor to UTC midnight so datepart never
  // drifts a day across timezones.
  const d = new Date(s);
  if (isNaN(d.getTime())) throw err(`"${v}" is not a date`);
  return d;
}

function datepart(v, fmt) {
  const d = parseDate(v);
  const mo = d.getUTCMonth() + 1, day = d.getUTCDate(), yr = d.getUTCFullYear();
  switch (S(fmt)) {
    case 'M': return String(mo);
    case 'MM': return String(mo).padStart(2, '0');
    case 'D': return String(day);
    case 'DD': return String(day).padStart(2, '0');
    case 'YYYY': return String(yr);
    case 'YY': return String(yr).slice(-2);
    default: throw err(`datepart: unknown format "${fmt}" (use M, MM, D, DD, YYYY, YY)`);
  }
}

// ───────────────────────── function table ─────────────────────────
// Each receives already-evaluated argument values (JS string/number/bool).

const FUNCS = {
  slice: (s, start, len) => {
    const str = S(s); const st = N(start);
    return len === undefined ? str.slice(st) : str.slice(st, st + N(len));
  },
  left: (s, n) => S(s).slice(0, N(n)),
  right: (s, n) => { const str = S(s); const k = N(n); return k <= 0 ? '' : str.slice(-k); },
  upper: (s) => S(s).toUpperCase(),
  lower: (s) => S(s).toLowerCase(),
  cap: (s) => { const str = S(s); return str ? str[0].toUpperCase() + str.slice(1) : ''; },
  trim: (s) => S(s).trim(),
  len: (s) => S(s).length,
  pad: (s, n, ch, side) => {
    const str = S(s); const width = N(n); const fill = ch === undefined ? '0' : S(ch);
    return (S(side) === 'right' ? str.padEnd(width, fill) : str.padStart(width, fill || '0'));
  },
  digits: (s) => S(s).replace(/\D+/g, ''),
  replace: (s, pattern, repl, flags) => {
    let re;
    try { re = new RegExp(S(pattern), flags === undefined ? 'g' : S(flags)); }
    catch (e) { throw err(`replace: bad regex — ${e.message}`); }
    return S(s).replace(re, S(repl));
  },
  match: (s, pattern, group) => {
    let re;
    try { re = new RegExp(S(pattern)); }
    catch (e) { throw err(`match: bad regex — ${e.message}`); }
    const m = re.exec(S(s));
    if (!m) return '';
    return group === undefined ? m[0] : S(m[N(group)] || '');
  },
  concat: (...args) => args.map(S).join(''),
  default: (a, b) => (S(a) === '' ? b : a),
  if: (cond, a, b) => (truthy(cond) ? a : b),
  datepart,
};
const ARG_CHECK = {
  // name -> [min, max] arity (max Infinity for variadic)
  slice: [2, 3], left: [2, 2], right: [2, 2], upper: [1, 1], lower: [1, 1],
  cap: [1, 1], trim: [1, 1], len: [1, 1], pad: [2, 4], digits: [1, 1],
  replace: [3, 4], match: [2, 3], concat: [0, Infinity], default: [2, 2],
  if: [3, 3], datepart: [2, 2],
};

// ───────────────────────── evaluator ─────────────────────────

function evalNode(node, ctx) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'ref': {
      const ns = ctx[node.ns];
      const v = ns ? ns[node.key] : undefined;
      return v == null ? '' : v;
    }
    case 'concat': return S(evalNode(node.a, ctx)) + S(evalNode(node.b, ctx));
    case 'neg': return -N(evalNode(node.a, ctx));
    case 'arith': {
      const a = N(evalNode(node.a, ctx)), b = N(evalNode(node.b, ctx));
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
      }
      break;
    }
    case 'cmp': {
      const a = evalNode(node.a, ctx), b = evalNode(node.b, ctx);
      switch (node.op) {
        case '==': return S(a) === S(b);
        case '!=': return S(a) !== S(b);
        case '>': return N(a) > N(b);
        case '<': return N(a) < N(b);
        case '>=': return N(a) >= N(b);
        case '<=': return N(a) <= N(b);
      }
      break;
    }
    case 'call': {
      const fn = FUNCS[node.name];
      if (!fn) throw err(`unknown function "${node.name}()"`);
      const [min, max] = ARG_CHECK[node.name];
      if (node.args.length < min || node.args.length > max) {
        throw err(`${node.name}() takes ${min === max ? min : `${min}-${max === Infinity ? '…' : max}`} args, got ${node.args.length}`);
      }
      // if() is lazy: only evaluate the taken branch.
      if (node.name === 'if') {
        return truthy(evalNode(node.args[0], ctx)) ? evalNode(node.args[1], ctx) : evalNode(node.args[2], ctx);
      }
      return fn(...node.args.map((a) => evalNode(a, ctx)));
    }
  }
  throw err(`cannot evaluate ${node.k}`);
}

// Compile a formula → AST. Throws a formula error on syntax problems. Cache by
// source string so repeated recomputes don't re-parse.
const _cache = new Map();
function compile(src) {
  const s = String(src || '');
  if (_cache.has(s)) return _cache.get(s);
  const tree = parse(s);
  if (_cache.size > 500) _cache.clear();
  _cache.set(s, tree);
  return tree;
}

// Evaluate `src` against `ctx` (the cannedRender context). Returns a string.
// `safe:true` swallows evaluation errors and returns '' (used at ticket-create
// so one bad formula can't block the whole ticket); otherwise throws so the
// admin preview can show the message.
function evaluate(src, ctx, { safe = false } = {}) {
  try {
    const tree = compile(src);
    const out = evalNode(tree, ctx || {});
    return out == null ? '' : String(out);
  } catch (e) {
    if (safe) return '';
    throw e;
  }
}

// Validate a formula's syntax without a context. Returns { ok, error }.
function validate(src) {
  try { compile(src); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { evaluate, validate, compile, tokenize, FUNCS };
