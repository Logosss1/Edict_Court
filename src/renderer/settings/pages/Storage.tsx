// 存储与备份: where the data lives (edict.db + files next to it), where it came from (fresh / 1.x import),
// on-demand backups, and what is (not) protected.
import { useCallback, useEffect, useState } from 'react';
import { toast } from '../../store';
import { call, isMac } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import type { StorageInfo } from '../../../shared/types';
import { Page, Row, Sec, Tile, Warn } from '../ui';
import { fmtBytes, fmtStamp } from './numField';
import './storage.css';

const reveal = () => (isMac() ? '在访达中显示' : '在文件夹中显示');

function Origin({ info }: { info: StorageInfo }) {
  const b = info.importBackup;
  // only a backup-1.x-<stamp>/ folder can be revealed (a recovery from *.json.migrated has none)
  const show = b?.startsWith('backup-1.x-') && (
    <button className="btn sm" onClick={() => call('revealBackup', b).catch((e) => toast((e as Error).message, 'error'))} data-testid="storage-reveal-import">
      <Icon name="folder" size={12} /> {reveal()}
    </button>
  );
  switch (info.origin) {
    case 'import:1.x':
      return (
        <Row label={<>从 1.x 迁移而来 <span className="storp-tag">已迁移</span></>} desc={<>首次启动 2.0 时，1.x 的 state.json / settings.json 在一次事务中全部导入了数据库；原文件复制到了 {b ? <code>{b}/</code> : '备份文件夹'}（内附回滚说明 README.txt），数据目录里的原件改名为 *.json.migrated。</>}>
          {show}
        </Row>
      );
    case 'import:backup':
      return (
        <Row label={<>从 1.x 备份恢复 <span className="storp-tag warn">已恢复</span></>} desc={<>数据库曾经损坏：坏文件已改名留作诊断（edict.db.corrupt-…），并从 {b ? <code>{b}</code> : '1.x 备份'} 重新导入。</>}>
          {show}
        </Row>
      );
    case 'fresh':
      return <Row label={<>全新安装 <span className="storp-tag">新建</span></>} desc="这个数据库是新建的，没有从旧版导入数据。" />;
    default:
      return <Row label="早期 2.0 版本创建" desc="这个数据库建于记录来源之前，没有迁移信息。" />;
  }
}

export function StoragePage() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call<StorageInfo>('storageInfo').then(setInfo).catch((e) => toast((e as Error).message, 'error')), []);
  useEffect(() => {
    void load();
  }, [load]);

  const backup = async () => {
    setBusy(true);
    try {
      const b = await call<{ name: string; bytes: number }>('backupNow');
      toast(`已备份：${b.name}（${fmtBytes(b.bytes)}）`, 'success', { label: reveal(), run: () => void call('revealBackup', b.name) });
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const openDir = () => call('openDataDir').catch((e) => toast((e as Error).message, 'error'));

  const c = info?.counts ?? {};
  const last = info?.backups[0];
  return (
    <Page icon="db" title="存储与备份" lead="Edict 的数据都在本机：一个 SQLite 数据库 edict.db，加上审计日志、活动记录和文件快照。" testid="settings-storage">
      <div className="storp">
        {!info ? (
          <div className="sp-empty">读取中…</div>
        ) : (
          <>
            <div className="stat-tiles storp-tiles">
              <Tile icon="db" label="数据库" value={fmtBytes(info.dbBytes + info.walBytes)} sub="edict.db（SQLite）" />
              <Tile icon="scroll" label="旨意" value={c.tasks ?? 0} sub={`奏折 ${c.memorials ?? 0} · 会话 ${c.sessions ?? 0} · 议政 ${c.debates ?? 0}`} />
              <Tile icon="history" label="备份" value={info.backups.length} sub={last ? `最近 ${fmtStamp(last.at)}` : '还没有备份'} tone={last ? undefined : 'attn'} />
              <Tile icon="key" label="API Key" value={info.encrypted ? '已加密' : '未加密'} sub={info.encrypted ? '系统钥匙串（safeStorage）' : '本机不支持 safeStorage'} tone={info.encrypted ? 'ok' : 'bad'} />
            </div>

            <Sec title="数据位置">
              <Row label="数据目录" desc={<code className="storp-path" {...tip(info.dataDir)}>{info.dataDir}</code>}>
                <button className="btn sm" onClick={() => void openDir()} data-testid="storage-open-dir"><Icon name="folder" size={12} /> 打开</button>
              </Row>
              <Row label="数据库" desc={<>edict.db：旨意、议政、会话、奏折、朱批、新闻、用量统计与设置都在这一个文件里。改动先在内存里攒约 250 毫秒，再在一个事务里写入{info.walBytes > 0 && <>；其中 {fmtBytes(info.walBytes)} 还在 WAL 日志（edict.db-wal）里，会自动并回主文件</>}。</>}>
                <span className="storp-size">{fmtBytes(info.dbBytes + info.walBytes)}</span>
              </Row>
              <Row label="同目录的其他文件" desc={<>不在数据库里：<code>audit.jsonl</code> 审计日志、<code>activity/</code> 活动记录、<code>blobs/</code> 文件快照、<code>skills/</code> 技能、<code>designs/</code> 协同设计、<code>mcp.json</code> 连接服务、<code>secrets.json</code> API Key 等。</>} />
            </Sec>

            <Sec title="数据来源">
              <Origin info={info} />
            </Sec>

            <Sec
              title="备份"
              note="· 存在数据目录的 backups/ 里，不会自动删除"
              right={
                <button className="btn primary sm" onClick={() => void backup()} disabled={busy} data-testid="storage-backup">
                  <Icon name={busy ? 'refresh' : 'copy'} size={12} /> {busy ? '备份中…' : '立即备份'}
                </button>
              }
            >
              {info.backups.length === 0 ? (
                <div className="sp-empty" data-testid="backups-empty">还没有备份。升级 Edict 或大改设置之前，建议先备份一份。</div>
              ) : (
                <table className="tbl2 storp-tbl" data-testid="backups-table">
                  <thead>
                    <tr><th>文件</th><th>时间</th><th>大小</th><th aria-label={reveal()} /></tr>
                  </thead>
                  <tbody>
                    {info.backups.map((b) => (
                      <tr key={b.name}>
                        <td><code>{b.name}</code></td>
                        <td className="storp-num">{fmtStamp(b.at)}</td>
                        <td className="storp-num">{fmtBytes(b.bytes)}</td>
                        <td className="storp-act">
                          <button className="link" onClick={() => call('revealBackup', b.name).catch((e) => toast((e as Error).message, 'error'))} data-testid={`backup-reveal-${b.name}`}>{reveal()}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="storp-howto">
                <Icon name="help" size={12} />
                <span>恢复：完全退出 Edict，把数据目录里的 edict.db（以及 edict.db-wal、edict.db-shm）移到别处，再把备份复制回来、改名为 edict.db。备份是数据库的完整副本（会先写完内存里的改动），不含审计日志、活动记录和 API Key。</span>
              </div>
            </Sec>

            <Sec title="安全">
              <ul className="storp-sec">
                <li><Icon name="alert" size={12} /><span>本地存储不是安全沙箱：本机上以你的身份运行的程序，都能读到数据目录里的文件（包括备份）。</span></li>
                {info.encrypted ? (
                  <li><Icon name="lock" size={12} /><span>API Key 用系统钥匙串（safeStorage）加密后存在 secrets.json，不进数据库、日志、审计和备份，也不会传给界面。</span></li>
                ) : (
                  <li className="bad"><Icon name="key" size={12} /><span>本机不支持 safeStorage 加密：API Key 只做了本地编码保存在 secrets.json（未加密）。它仍不进数据库、日志、审计和备份。</span></li>
                )}
                <li><Icon name="scroll" size={12} /><span>数据库和备份里有旨意原文、方案、对话与回奏；发给别人之前请先看一眼。</span></li>
              </ul>
              {!info.encrypted && <Warn>建议在支持钥匙串的系统上使用，或只填权限受限、可随时作废的 API Key。</Warn>}
            </Sec>
          </>
        )}
      </div>
    </Page>
  );
}
