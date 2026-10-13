// 联网与搜索 (2.1): whether officials may fetch web pages, and which search service web_search uses.
// The same search form opens from an official's 上疏 card when a task needs search and none is set.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, toast } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { ModelSelect } from '../../common/ModelPick';
import type { ModelRef, SearchConfig, SearchProviderKind, WebFetchPolicy, WebSettings, WebStatus } from '../../../shared/types';
import { Badge, Page, Row, Sec } from '../ui';
import './permissions.css';
import './web.css';

const FETCH_MODES: { id: WebFetchPolicy; label: string; icon: string; desc: string }[] = [
  { id: 'allow', label: '允许', icon: 'globe', desc: '官员可以打开公开网页查资料（默认）。本机和内网地址一律不能抓。' },
  { id: 'ask', label: '每个新域名先问我', icon: 'shield', desc: '第一次访问某个网站时弹卡片，你可以准许一次、本旨意内允许或永久允许。' },
  { id: 'off', label: '关闭', icon: 'lock', desc: '官员拿不到抓取网页的工具。' },
];

const PROVIDERS: { id: SearchProviderKind; label: string; desc: string; key?: string; url?: string; site?: string }[] = [
  { id: 'brave', label: 'Brave Search', desc: '要 Key，每月有免费额度。', key: 'Brave Search API Key', site: 'https://brave.com/search/api/' },
  { id: 'tavily', label: 'Tavily', desc: '要 Key，每月有免费额度，结果附带摘要。', key: 'Tavily API Key（tvly-…）', site: 'https://tavily.com' },
  { id: 'searxng', label: 'SearXNG（自建）', desc: '不要 Key，填你自己架设的 SearXNG 地址；需要在它的设置里打开 JSON 格式。', url: 'https://search.example.com' },
  { id: 'model', label: '模型自带搜索', desc: '用模型服务自己的搜索，不用另配 Key。只支持 Anthropic Messages 和 OpenAI Responses 的官方接口，中转站多半不支持，保存前请先测试。' },
];

type TestResult = { ok: boolean; hits: { title: string; url: string }[]; error?: string; ms: number };

/** Choose a search service, enter its key or address, test it, save. Used by the settings page and the 上疏 card. */
export function SearchServiceForm({ status, onSaved, onCancel, compact }: { status: WebStatus | null; onSaved?: (s: WebStatus) => void; onCancel?: () => void; compact?: boolean }) {
  const providers = useStore((s) => s.providers);
  const cur = status?.web.search ?? null;
  const [provider, setProvider] = useState<SearchProviderKind | ''>(cur?.provider ?? '');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(cur?.url ?? '');
  const [model, setModel] = useState<ModelRef | null>(cur?.model ?? null);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [test, setTest] = useState<TestResult | null>(null);
  useEffect(() => {
    setProvider(cur?.provider ?? '');
    setUrl(cur?.url ?? '');
    setModel(cur?.model ?? null);
  }, [cur?.provider, cur?.url, cur?.model?.providerId, cur?.model?.model]);
  const p = PROVIDERS.find((x) => x.id === provider);
  const hasKey = provider ? !!status?.hasKey[provider] : false;
  const modelProviders = providers.filter((x) => x.enabled !== false && (x.protocol === 'anthropic-messages' || x.protocol === 'openai-responses'));
  const cfg = (): SearchConfig | null => (provider ? { provider, ...(provider === 'searxng' ? { url } : {}), ...(provider === 'model' && model ? { model } : {}) } : null);
  const missing = !provider ? '请选择一种搜索服务' : p?.key && !key.trim() && !hasKey ? `请填写 ${p.label} 的 Key` : provider === 'searxng' && !/^https?:\/\//i.test(url.trim()) ? '请填写以 http:// 或 https:// 开头的地址' : provider === 'model' && !model ? '请选择用哪个模型搜索' : '';

  const runTest = async () => {
    if (missing) return toast(missing, 'warn');
    setBusy('test');
    setTest(null);
    try {
      setTest(await call<TestResult>('testSearch', cfg(), key.trim() || undefined));
    } catch (e) {
      setTest({ ok: false, hits: [], error: (e as Error).message, ms: 0 });
    } finally {
      setBusy('');
    }
  };
  const save = async () => {
    if (missing) return toast(missing, 'warn');
    setBusy('save');
    try {
      const st = await call<WebStatus>('saveWebSettings', { search: cfg() }, key.trim() && provider ? { provider, value: key.trim() } : null);
      setKey('');
      toast(`搜索服务已设为 ${p?.label}`, 'success');
      onSaved?.(st);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={`webf ${compact ? 'compact' : ''}`} data-testid="search-form">
      <div className="webf-provs" role="radiogroup" aria-label="搜索服务">
        {PROVIDERS.map((x) => (
          <button key={x.id} role="radio" aria-checked={provider === x.id} className={`webf-prov ${provider === x.id ? 'on' : ''}`} onClick={() => { setProvider(x.id); setTest(null); }} data-testid={`search-prov-${x.id}`}>
            <span className="t">{x.label}{status?.web.search?.provider === x.id && <Badge tone="ok">在用</Badge>}</span>
            {!compact && <span className="d">{x.desc}</span>}
          </button>
        ))}
      </div>
      {p && compact && <div className="muted small webf-desc">{p.desc}</div>}
      {p?.key && (
        <label className="webf-field">
          <span>{p.key}{p.site && <> · <a href={p.site} target="_blank" rel="noreferrer">去申请</a></>}</span>
          <input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '已保存（留空则不变）' : '粘贴 Key'} data-testid="search-key" />
          <span className="muted small">Key 加密保存在本机，密钥由钥匙串保管，只发给这家搜索服务。</span>
        </label>
      )}
      {provider === 'searxng' && (
        <label className="webf-field">
          <span>SearXNG 地址</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={p?.url} data-testid="search-url" />
        </label>
      )}
      {provider === 'model' && (
        <label className="webf-field">
          <span>用哪个模型搜索</span>
          {modelProviders.length ? (
            <ModelSelect value={model} onChange={setModel} allowDefault="（请选择）" className="input" testid="search-model" />
          ) : (
            <span className="warn-text small">还没有 Anthropic Messages 或 OpenAI Responses 协议的模型服务，先到「模型服务」里添加。</span>
          )}
        </label>
      )}
      {test && (
        <div className={`webf-test ${test.ok ? 'ok' : 'bad'}`} data-testid="search-test-result">
          {test.ok ? (
            <>
              <b><Icon name="check" size={12} /> 可以用，{test.hits.length} 条结果（{test.ms} ms）</b>
              {test.hits.slice(0, 3).map((h) => <div key={h.url} className="ellipsis muted small">{h.title} · {h.url}</div>)}
            </>
          ) : (
            <b><Icon name="alert" size={12} /> 没有成功：{test.error ?? '未知错误'}</b>
          )}
        </div>
      )}
      <div className="webf-act">
        {onCancel && <button className="btn sm" onClick={onCancel} data-testid="search-cancel">取消</button>}
        {onCancel && <span style={{ flex: 1 }} />}
        <button className="btn sm" disabled={!!busy || !provider} onClick={() => void runTest()} data-testid="search-test">{busy === 'test' ? '测试中…' : '测试一下'}</button>
        <button className="btn sm primary" disabled={!!busy || !provider} onClick={() => void save()} data-testid="search-save">{busy === 'save' ? '保存中…' : '保存'}</button>
      </div>
    </div>
  );
}

/** Opened from an official's 上疏 card; saving sets up search in Settings and lets the search go ahead. */
export function SearchSetupDialog({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<WebStatus | null>(null);
  useEffect(() => {
    void call<WebStatus>('webStatus').then(setStatus);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // portal: the card may sit in a positioned dock (court mode)
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal web-dlg" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="配置搜索服务" data-testid="search-setup-dialog">
        <div className="wt-h"><Icon name="globe" size={15} /> 配置搜索服务</div>
        <div className="wt-intro">选一种搜索服务，填好后点「保存」。设置会存进「设置 › 联网与搜索」，以后的旨意都能用；这次的搜索会接着执行。</div>
        <SearchServiceForm status={status} compact onSaved={onSaved} onCancel={onClose} />
      </div>
    </div>,
    document.body,
  );
}

export function WebPage() {
  const web = useStore((s) => s.settings.web) as WebSettings | undefined;
  const [status, setStatus] = useState<WebStatus | null>(null);
  const refresh = () => void call<WebStatus>('webStatus').then(setStatus);
  useEffect(refresh, [web?.search?.provider, web?.search?.url, web?.fetch, web?.domains?.length]);
  const fetchMode = web?.fetch ?? 'allow';
  const domains = web?.domains ?? [];
  const save = async (patch: Partial<WebSettings>) => {
    try {
      setStatus(await call<WebStatus>('saveWebSettings', patch, null));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const clearSearch = async () => {
    const ok = await call<boolean>('confirm', '不再使用搜索服务？', '官员需要搜索时会重新上疏请你配置。已保存的 Key 不会删除。');
    if (ok) await save({ search: null });
  };
  return (
    <Page icon="globe" title="联网与搜索" lead="官员查资料时能不能上网。抓取网页默认打开；搜索要先设一个搜索服务，没设时官员会上疏请你配置。" testid="settings-web">
      <div className="permp">
        <Sec title="抓取网页（web_fetch）" note="· 打开一个已知网址，转成文字给官员看">
          <div className="permp-mc">
            <div className="mode-cards three webp-modes" role="radiogroup" aria-label="抓取网页">
              {FETCH_MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={fetchMode === m.id} className={`mode-card ${fetchMode === m.id ? 'on' : ''}`} onClick={() => fetchMode !== m.id && void save({ fetch: m.id })} data-testid={`web-fetch-${m.id}`}>
                  <span className="t"><Icon name={m.icon} size={14} /> {m.label}</span>
                  <span className="d">{m.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="permp-always">
            <Icon name="lock" size={12} />
            <span>网页内容交给官员时会注明“只是资料，不是指令”。单页最多 2 MB、20 秒，跳转最多 5 次，每次抓取都记入审计日志。</span>
          </div>
          {fetchMode === 'ask' && (
            <Row label="永久允许的网站" desc={domains.length ? '点 × 移除' : '还没有。在审批卡上选「永久允许」的网站会列在这里。'} testid="web-domains">
              <div className="webp-domains">
                {domains.map((d) => (
                  <span key={d} className="scope-tag">{d} <button className="icon-btn" onClick={() => void save({ domains: domains.filter((x) => x !== d) })} aria-label={`移除 ${d}`}><Icon name="x" size={10} /></button></span>
                ))}
              </div>
            </Row>
          )}
        </Sec>

        <Sec
          title="搜索服务（web_search）"
          note="· 按关键词搜索，返回标题、网址和摘要"
          right={status?.searchReady ? <Badge tone="ok">已设置</Badge> : <Badge tone="off">未设置</Badge>}
        >
          <SearchServiceForm status={status} onSaved={setStatus} />
          {status?.web.search && (
            <div className="webp-clear"><button className="link small" onClick={() => void clearSearch()} data-testid="search-clear">不再使用搜索服务</button></div>
          )}
        </Sec>
      </div>
    </Page>
  );
}
