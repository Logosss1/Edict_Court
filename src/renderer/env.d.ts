// Ambient declarations for the renderer bundle (esbuild handles these imports).
declare module '*.css';
declare module '*/vendor/xterm/xterm.mjs' {
  // vendored xterm.js 5.5 (bundled from source, no .d.ts shipped)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Terminal: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const FitAddon: any;
}
