// Lazy loaders for the vendored AMD Monaco build and the Phaser UMD build.
let monacoP: Promise<any> | null = null;

export function loadMonaco(): Promise<any> {
  if (monacoP) return monacoP;
  monacoP = new Promise((resolve, reject) => {
    const base = new URL('../vendor/monaco/', location.href).toString().replace(/\/$/, '');
    window.MonacoEnvironment = { getWorkerUrl: () => `${base}/vs/base/worker/workerMain.js` };
    const req = window.require;
    if (!req?.config) return reject(new Error('Monaco loader 未加载'));
    req.config({ paths: { vs: `${base}/vs` }, 'vs/nls': { availableLanguages: { '*': 'zh-cn' } } });
    req(['vs/editor/editor.main'], () => {
      const m = window.monaco;
      m.editor.defineTheme('edict-dark', {
        base: 'vs-dark', inherit: true,
        rules: [ { token: 'comment', foreground: '7d705f', fontStyle: 'italic' }, { token: 'keyword', foreground: 'e0795a' }, { token: 'string', foreground: 'b5c77a' }, { token: 'number', foreground: 'd8a84e' }, { token: 'type', foreground: '6fb8a8' } ],
        colors: { 'editor.background': '#15120f', 'editor.lineHighlightBackground': '#201a15', 'editorLineNumber.foreground': '#5a4d40', 'editorLineNumber.activeForeground': '#c9a86a', 'editor.selectionBackground': '#5a3a2a88', 'editorCursor.foreground': '#e8b64c', 'editorWidget.background': '#1d1813', 'diffEditor.insertedTextBackground': '#3f7a5533', 'diffEditor.removedTextBackground': '#b3322a33' },
      });
      m.editor.defineTheme('edict-light', {
        base: 'vs', inherit: true, rules: [ { token: 'keyword', foreground: 'a8321f' }, { token: 'comment', foreground: '8c7b64', fontStyle: 'italic' } ],
        colors: { 'editor.background': '#fbf7ef', 'editor.lineHighlightBackground': '#f2eadb', 'editorCursor.foreground': '#b3322a' },
      });
      m.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
      m.languages.typescript?.typescriptDefaults?.setCompilerOptions({ target: 99, allowNonTsExtensions: true, moduleResolution: 2, module: 99, jsx: 4, allowJs: true, checkJs: false, strict: false, noEmit: true, esModuleInterop: true });
      m.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      resolve(m);
    }, (err: unknown) => reject(err));
  });
  return monacoP;
}

export function monacoTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'edict-light' : 'edict-dark';
}

export function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', py: 'python', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'shell',
    bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql', dockerfile: 'dockerfile', lua: 'lua', dart: 'dart', r: 'r',
  };
  if (/(^|\/)Dockerfile$/.test(path)) return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

let phaserP: Promise<any> | null = null;
export function loadPhaser(): Promise<any> {
  if (window.Phaser) return Promise.resolve(window.Phaser);
  if (phaserP) return phaserP;
  phaserP = new Promise((resolve, reject) => {
    // Hide the AMD `define` from Phaser's UMD wrapper so it registers as a global.
    const savedDefine = window.define;
    window.define = undefined;
    const s = document.createElement('script');
    s.src = '../vendor/phaser/phaser.min.js';
    s.onload = () => {
      window.define = savedDefine;
      resolve(window.Phaser);
    };
    s.onerror = (e) => {
      window.define = savedDefine;
      reject(e);
    };
    document.head.appendChild(s);
  });
  return phaserP;
}
