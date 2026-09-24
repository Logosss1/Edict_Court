import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initStore } from './store';
import './styles.css';

function applyTheme(pref: string | undefined) {
  const dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.monaco?.editor?.setTheme(dark ? 'edict-dark' : 'edict-light');
}

(async () => {
  document.documentElement.dataset.platform = window.edict.platform;
  await initStore();
  const { getState, subscribe, openPanel, setUI } = await import('./store');
  // automation hook for E2E tests (no privileged capability; same as clicking the UI)
  (window as unknown as Record<string, unknown>).__openPanel = openPanel;
  (window as unknown as Record<string, unknown>).__edictUI = { getState, setUI };
  let last = '';
  const sync = () => {
    const t = getState().settings.theme;
    if (t !== last) {
      last = t;
      applyTheme(t);
    }
  };
  sync();
  subscribe(sync);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getState().settings.theme));
  createRoot(document.getElementById('root')!).render(<App />);
})().catch((e) => {
  document.getElementById('root')!.innerHTML = `<div class="boot">启动失败：${String(e?.message ?? e)}</div>`;
});
