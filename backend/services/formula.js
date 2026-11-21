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

// ───────────────────────── random generators ─────────────────────────

const crypto = require('crypto');
const wordlist = require('./wordlist');

const DEFAULT_SPECIALS = '!@#$%&*?-+=';
// Functions whose output is random. Used to make minlen() retry and to mark a
// formula volatile so recompute doesn't re-roll stored values.
const RANDOM_FUNCS = new Set(['word', 'num', 'special', 'rand', 'pick']);
const MINLEN_TRIES = 200;

// Integer argument within [lo, hi] or a clear error.
function INT(v, fn, what, lo, hi) {
  const n = N(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw err(`${fn}: ${what} must be a whole number ${lo}–${hi}, got ${v}`);
  return n;
}

const randIdx = (n) => crypto.randomInt(n);

function genWord(min, max) {
  const lo = min === undefined ? wordlist.MIN_LEN : INT(min, 'word', 'min length', 1, 64);
  const hi = max === undefined ? (min === undefined ? wordlist.MAX_LEN : lo) : INT(max, 'word', 'max length', 1, 64);
  if (hi < lo) throw err(`word: max length ${hi} is less than min ${lo}`);
  const pool = wordlist.wordsBetween(lo, hi);
  if (!pool.length) throw err(`word: no library words are ${lo === hi ? lo : `${lo}–${hi}`} letters (library has ${wordlist.MIN_LEN}–${wordlist.MAX_LEN})`);
  return pool[randIdx(pool.length)];
}

function genNum(count) {
  const k = INT(count, 'num', 'digit count', 1, 32);
  let out = '';
  for (let i = 0; i < k; i++) out += String(randIdx(10));
  return out;
}

function genSpecial(count, charset) {
  const k = count === undefined ? 1 : INT(count, 'special', 'count', 1, 32);
  const set = charset === undefined ? DEFAULT_SPECIALS : S(charset);
  if (!set) throw err('special: character set is empty');
  const chars = Array.from(set);
  let out = '';
  for (let i = 0; i < k; i++) out += chars[randIdx(chars.length)];
  return out;
}

function genRand(a, b) {
  const lo = INT(a, 'rand', 'min', -1e9, 1e9), hi = INT(b, 'rand', 'max', -1e9, 1e9);
  if (hi < lo) throw err(`rand: max ${hi} is less than min ${lo}`);
  return lo + crypto.randomInt(hi - lo + 1);
}

// upper/lower: n omitted or 0 = whole string; n>0 = only the first n chars.
function caseN(fn, s, n, conv) {
  const str = S(s);
  const k = n === undefined ? 0 : INT(n, fn, 'character count', 0, 1e6);
  return k === 0 ? conv(str) : conv(str.slice(0, k)) + str.slice(k);
}

// Does this AST (sub)tree call any random generator?
function treeIsVolatile(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.k === 'call' && RANDOM_FUNCS.has(node.name)) return true;
  if (node.args && node.args.some(treeIsVolatile)) return true;
  return treeIsVolatile(node.a) || treeIsVolatile(node.b);
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
  upper: (s, n) => caseN('upper', s, n, (x) => x.toUpperCase()),
  lower: (s, n) => caseN('lower', s, n, (x) => x.toLowerCase()),
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
  word: genWord,
  num: genNum,
  special: genSpecial,
  rand: genRand,
  pick: (...args) => args[randIdx(args.length)],
  minlen: () => { throw err('minlen is evaluated lazily'); }, // handled in evalNode
};
const ARG_CHECK = {
  // name -> [min, max] arity (max Infinity for variadic)
  slice: [2, 3], left: [2, 2], right: [2, 2], upper: [1, 2], lower: [1, 2],
  cap: [1, 1], trim: [1, 1], len: [1, 1], pad: [2, 4], digits: [1, 1],
  replace: [3, 4], match: [2, 3], concat: [0, Infinity], default: [2, 2],
  if: [3, 3], datepart: [2, 2],
  word: [0, 2], num: [1, 1], special: [0, 2], rand: [2, 2], pick: [1, Infinity],
  minlen: [2, 3],
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
      // minlen(expr, min[, max]) is lazy too: re-evaluate expr until its
      // length fits. A non-random expr gets one try (re-rolling can't help).
      if (node.name === 'minlen') {
        const min = INT(evalNode(node.args[1], ctx), 'minlen', 'min', 0, 1024);
        const max = node.args[2] === undefined ? Infinity : INT(evalNode(node.args[2], ctx), 'minlen', 'max', 0, 1024);
        if (max < min) throw err(`minlen: max ${max} is less than min ${min}`);
        const tries = treeIsVolatile(node.args[0]) ? MINLEN_TRIES : 1;
        let v = '';
        for (let i = 0; i < tries; i++) {
          v = S(evalNode(node.args[0], ctx));
          if (v.length >= min && v.length <= max) return v;
        }
        const want = max === Infinity ? `at least ${min}` : `${min}–${max}`;
        throw err(tries > 1
          ? `minlen: couldn't produce a value of ${want} chars in ${tries} tries — widen the word()/num() lengths`
          : `minlen: value is ${v.length} chars, needs ${want}`);
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

// True when the formula calls a random generator (word/num/special/rand/pick),
// i.e. evaluating it twice gives different answers. Invalid formulas → false.
function isVolatile(src) {
  try { return treeIsVolatile(compile(src)); }
  catch { return false; }
}

// Validate a formula's syntax without a context. Returns { ok, error }.
function validate(src) {
  try { compile(src); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { evaluate, validate, compile, tokenize, isVolatile, FUNCS, DEFAULT_SPECIALS };
