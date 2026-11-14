// Fails when a component or variable is used but never defined or
// imported. `vite build` doesn't catch these: the page only crashes at
// runtime when that code path renders (e.g. a missing AiRewriteButton
// import crashed the ticket page whenever the title editor opened).
// Uses Babel's scope analysis; @babel/* ships with @vitejs/plugin-react.
//   npm run check:undefined
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const root = path.join(here, '..', 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|tsx?)$/.test(f)) files.push(p);
  }
})(root);

const GLOBALS = new Set(Object.getOwnPropertyNames(globalThis).concat([
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'fetch', 'console', 'location',
  'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Notification', 'FormData', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'Image', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle', 'matchMedia',
  'atob', 'btoa', 'crypto', 'performance', 'history', 'screen', 'self', 'caches', 'indexedDB',
  'AbortController', 'TextEncoder', 'TextDecoder', 'structuredClone', 'queueMicrotask', 'Audio',
  'DOMParser', 'XMLSerializer', 'Worker', 'WebSocket', 'EventSource', 'BroadcastChannel', 'ClipboardItem',
  'process', 'import', 'arguments', 'undefined', 'NaN', 'Infinity', 'globalThis', 'React', 'PublicKeyCredential',
  'ServiceWorkerRegistration', 'PushManager', 'MediaRecorder', 'SpeechSynthesisUtterance', 'speechSynthesis',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Range', 'Selection', 'getSelection', 'DataTransfer',
  'open', 'print', 'scrollTo', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'visualViewport', 'origin',
]));

let problems = 0;
for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch (e) { console.log('PARSE', f, e.message); continue; }
  const seen = new Set();
  traverse(ast, {
    'ReferencedIdentifier|JSXIdentifier'(p) {
      let name;
      if (p.isJSXIdentifier()) {
        if (!p.parentPath.isJSXOpeningElement() && !p.parentPath.isJSXClosingElement()) return;
        name = p.node.name;
        if (!/^[A-Z]/.test(name)) return; // intrinsic html tag
      } else {
        name = p.node.name;
      }
      if (p.scope.hasBinding(name, true) || GLOBALS.has(name)) return;
      const key = `${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      problems++;
      console.log(`${path.relative(root, f)}:${p.node.loc?.start.line}  ${name}`);
    },
  });
}
if (problems) {
  console.error(`\n${problems} undefined identifier(s). Add the missing import, or add a real global to GLOBALS.`);
  process.exit(1);
}
console.log('check:undefined: no undefined identifiers');
