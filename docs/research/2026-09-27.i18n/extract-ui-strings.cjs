// Inventory of user-visible string candidates via the TypeScript AST (comments excluded by construction).
const ROOT = require('path').resolve(__dirname, '../../..');
const ts = require(require('path').join(ROOT, 'frontend/node_modules/typescript'));
const fs = require('fs'); const path = require('path');
const HANGUL = /[가-힣ㄱ-ㆎ]/;
const UI_ATTRS = new Set(['title','aria-label','placeholder','alt','label','aria-description','aria-valuetext','aria-roledescription']);
const UI_PROPS = /^(label|title|message|description|tooltip|placeholder|text|heading|hint|caption|confirmLabel|cancelLabel|confirmText|cancelText|body|detail|summary|emptyText|ariaLabel|subtitle|reason|helpText|errorMessage|actionLabel|buttonLabel|name)$/;
const NON_UI_ATTRS = new Set(['className','class','id','key','type','role','data-testid','href','src','style','name','value','htmlFor','rel','target','method','autoComplete','inputMode','lang','dir','viewBox','d','fill','stroke','xmlns','width','height','tabIndex','draggable','spellCheck','accept','pattern']);
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules','dist','__tests__'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
function calleeName(node) {
  // nearest enclosing call: console.x / logger.x / throw new Error
  let n = node.parent, depth = 0;
  while (n && depth < 6) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const t = n.expression.getText();
      return t;
    }
    if (ts.isThrowStatement(n)) return 'throw';
    if (ts.isBlock(n) || ts.isSourceFile(n)) break;
    n = n.parent; depth++;
  }
  return '';
}
function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  let s = node.head.text; let i = 0;
  for (const span of node.templateSpans) { s += `{${i++}}` + span.literal.text; }
  return s;
}
function classify(file, sf) {
  const items = [];
  const push = (node, text, kind, ctx) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    // ctx can be a multi-line callee (e.g. `[...].filter`); collapse it so a TSV row stays one line.
    items.push({ file: path.relative(ROOT, file), line: line + 1, kind, ctx: ctx.replace(/\s+/g, ' ').trim(), text: t, hangul: HANGUL.test(t) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isJsxText(node)) { if (/[A-Za-z가-힣]/.test(node.text)) push(node, node.text, 'jsx-text', ''); return; }
    // Regex literals are not copy, but a Hangul one matches copy (e.g. stripping a localized prefix) — list those.
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) { if (HANGUL.test(node.text)) push(node, node.text, 'regex', ''); return; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isStringLiteral(node) ? node.text : templateText(node);
      const p = node.parent;
      if (p && (ts.isPropertyAssignment(p) && p.name === node)) return; // object key
      if (p && ts.isElementAccessExpression(p) && p.argumentExpression === node) return;
      if (p && ts.isCaseClause(p)) return;
      let ctx = '', kind = 'string';
      if (p && ts.isJsxAttribute(p)) { ctx = p.name.getText(); kind = UI_ATTRS.has(ctx) ? 'jsx-ui-attr' : (NON_UI_ATTRS.has(ctx) ? 'jsx-nonui-attr' : 'jsx-attr'); }
      else if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) { ctx = p.parent.name.getText(); kind = UI_ATTRS.has(ctx) ? 'jsx-ui-attr' : 'jsx-attr'; }
      else if (p && ts.isPropertyAssignment(p)) { ctx = p.name.getText().replace(/['"]/g, ''); kind = UI_PROPS.test(ctx) ? 'ui-prop' : 'prop'; }
      else { const c = calleeName(node); ctx = c; if (/^console\.|log(ger)?\.|\.(info|warn|error|debug|log)$/.test(c)) kind = 'log'; else if (c === 'throw' || /Error$/.test(c)) kind = 'error'; }
      if (kind === 'jsx-nonui-attr') return;
      push(node, text, kind, ctx);
      if (ts.isTemplateExpression(node)) { node.templateSpans.forEach(s => ts.forEachChild(s.expression, visit)); }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return items;
}
const groups = {
  frontend: walk(path.join(ROOT, 'frontend/src'), []).filter(f => !f.includes('/editor/vendor/')),
  'frontend-editor-vendor': walk(path.join(ROOT, 'frontend/src/editor/vendor'), []),
  server: walk(path.join(ROOT, 'server/src'), []).filter(f => !/test-runner\.ts$|\/benchmarks\/|\/testing\//.test(f)),
  tools: walk(path.join(ROOT, 'tools'), []).filter(f => !/\/(wave\d|fixtures?)\//.test(f)),
};
const all = {};
for (const [g, files] of Object.entries(groups)) {
  all[g] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, /x$/.test(f) ? ts.ScriptKind.TSX : (/\.ts$/.test(f) ? ts.ScriptKind.TS : ts.ScriptKind.JS));
    all[g].push(...classify(f, sf));
  }
}
fs.writeFileSync(process.argv[2] || 'inventory.json', JSON.stringify(all, null, 1));
// Optional argv[3]: directory for the two TSVs. ko = every frontend Hangul literal (strings, JSX text, and kind 'regex');
// en-candidates = frontend non-Hangul literals of UI-ish kinds outside dead code (CLAUDE.md Project Structure list).
if (process.argv[3]) {
  const DEAD = [/\/hooks\/(useSession|useTabManager|useKeyboardNav|useCwd|useFileContent|useLayoutMode|useFileBrowser)\.ts$/, /\/components\/(FileManager|Sidebar|StatusBar)\//, /\/components\/Modal\/ShellSelectModal\.tsx$/, /\/components\/MetadataBar\/index\.ts$/, /\/utils\/(viewableExtensions|splitWebSocketLifecycle)\.ts$/, /\/Grid\/EmptyCell\.tsx$/];
  const HEADER = 'file\tline\tkind\tcontext\ttext';
  const row = (i) => [i.file, i.line, i.kind, i.ctx, i.text].join('\t');
  const ko = all.frontend.filter((i) => i.hangul);
  const en = all.frontend.filter((i) => !i.hangul && !DEAD.some((r) => r.test(i.file)) && ['error', 'jsx-text', 'jsx-ui-attr', 'ui-prop'].includes(i.kind));
  fs.writeFileSync(path.join(process.argv[3], 'ui-strings.ko.tsv'), [HEADER, ...ko.map(row)].join('\n') + '\n');
  fs.writeFileSync(path.join(process.argv[3], 'ui-strings.en-candidates.tsv'), [HEADER, ...en.map(row)].join('\n') + '\n');
}
for (const [g, items] of Object.entries(all)) {
  const byKind = {};
  for (const it of items) { const k = it.kind + (it.hangul ? ':ko' : ':en'); byKind[k] = (byKind[k] || 0) + 1; }
  const ko = items.filter(i => i.hangul && i.kind !== 'regex');
  const rx = items.filter(i => i.kind === 'regex');
  const uniqKo = new Set(ko.map(i => i.text));
  const files = new Set(ko.map(i => i.file));
  console.log(`== ${g}: files scanned=${groups[g].length} hangul literals=${ko.length} unique=${uniqKo.size} files-with-hangul=${files.size} hangul-regex=${rx.length}`);
  console.log('   ', JSON.stringify(byKind));
}
