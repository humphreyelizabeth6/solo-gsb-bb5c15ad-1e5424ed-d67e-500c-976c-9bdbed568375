import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../useSocket.js';
import { formatTime, formatClock, formatWallTime, liveRemaining, liveAgenda } from '../time.js';
import { loadScreen, saveScreenName } from '../screen.js';
import { activeScene } from '../scene.js';

// 投屏页：按服务端下发的“当前场景完整快照”一次性整体替换模块与布局。
// 场景（模块开关 + 布局参数）与数据通道（计时快照/提示/标记摘要）正交：
//  - 倒计时/议程/提示/标记摘要四模块按当前场景配置显隐；
//  - 提示模块关闭时未确认提示仅暂挂（useSocket 中），重新开启后复显，切换不丢提示；
//  - 旧场景迟到消息由版本守卫丢弃，断线重连首包恢复当前场景。
// 屏幕身份（持久 ID + 显示名）首次打开生成，刷新沿用。
export default function DisplayPage() {
  // 仅初始化一次：WebSocket 重连时反复使用同一身份注册
  const screenRef = useRef(null);
  if (!screenRef.current) screenRef.current = loadScreen();
  const {
    snap, connState, cue, scenes, sceneMarkers,
    screenConflict, renameScreen, ackCue,
  } = useSocket({ role: 'display', screenRef: screenRef.current });
  const [, force] = useState(0);

  // 100ms 重绘：对 running 快照做本地插值，保证大屏数字与议程预计时间平滑
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  const scene = activeScene(scenes);
  const mods = scene.modules;
  const cueVisible = !!cue && !!mods.cue; // 提示模块关闭：暂挂不上屏，但未确认提示不丢失

  useEffect(() => {
    document.title = cueVisible
      ? `${cue.text} · 后台提示`
      : snap
        ? `${formatTime(liveRemaining(snap))} · 发言计时`
        : '发言计时投屏';
  });

  const stateCls = cueVisible
    ? 'display display-cue-mode'
    : snap?.finished
      ? 'display display-finished'
      : snap?.warning
        ? 'display display-warning'
        : snap?.phase === 'idle'
          ? 'display display-idle'
          : 'display display-running';
  const rootClass = `${stateCls} scene-theme-${scene.layout.theme} scene-size-${scene.layout.size} scene-align-${scene.layout.align}`;

  return (
    <div className={rootClass}>
      {connState !== 'open' && (
        <div className="reconnect-banner">
          {connState === 'reconnecting' ? '网络中断，正在重连并同步时间…' : '连接中…'}
        </div>
      )}

      {screenConflict && (
        <div className="screen-conflict-banner">
          此屏幕身份已被新打开的投屏页顶替，本页面不再接收提示；请关闭重复页面后刷新本页。
        </div>
      )}

      {cueVisible ? (
        <CueOverlay cue={cue} onAck={() => ackCue(cue.cueSeq)} />
      ) : (
        <DisplayBody snap={snap} mods={mods} sceneMarkers={sceneMarkers} />
      )}

      <ScreenNameChip screenRef={screenRef} renameScreen={renameScreen} />
    </div>
  );
}

function DisplayBody({ snap, mods, sceneMarkers }) {
  if (!snap) {
    return (
      <>
        <div className="display-time">--:--</div>
        <div className="display-state">等待连接…</div>
      </>
    );
  }

  const remaining = liveRemaining(snap);
  const agenda = liveAgenda(snap);
  const cur = agenda?.items.find((it) => it.status === 'current') ?? null;
  const curIdx = cur ? agenda.items.findIndex((it) => it.id === cur.id) : -1;
  const next = curIdx >= 0 ? agenda.items[curIdx + 1] ?? null : null;
  const allOff = !mods.countdown && !mods.agenda && !mods.markers;

  return (
    <>
      {/* 议程模块：当前环节行 */}
      {mods.agenda && cur && (
        <div className="display-current">
          <span className="display-current-name">{cur.name}</span>
          {cur.fixed && <span className="display-pin">📌 固定环节</span>}
          {cur.insufficient && <span className="display-short">⚠ 时间不足</span>}
        </div>
      )}

      {/* 倒计时模块：相位 + 大字时间 + 状态 */}
      {mods.countdown && (
        <>
          <div className="display-phase">{phaseText(snap.phase)}</div>
          <div className="display-time">
            {snap.finished ? '00:00' : formatTime(remaining, { tenths: snap.warning && snap.phase === 'running' })}
          </div>
          <div className="display-state">
            {snap.finished
              ? '时间到'
              : snap.phase === 'idle'
                ? '待开始'
                : snap.phase === 'paused'
                  ? '已暂停'
                  : snap.warning
                    ? '剩余不足 1 分钟'
                    : '发言进行中'}
          </div>
        </>
      )}

      {/* 议程模块：下一环节（无当前环节时倒计时模块回显设定时长） */}
      {mods.agenda ? (
        next ? (
          <div className={`display-next ${next.insufficient ? 'display-next-short' : ''}`}>
            <span className="display-next-label">下一环节</span>
            <span className="display-next-name">{next.name}{next.fixed ? ' 📌' : ''}</span>
            <span className="display-next-time">预计开始 {formatClock(next.projStartMs)}</span>
          </div>
        ) : cur ? (
          <div className="display-next">
            <span className="display-next-label">本环节为最后一项</span>
          </div>
        ) : mods.countdown ? (
          <div className="display-duration">设定时长 {formatTime(snap.durationMs)}</div>
        ) : null
      ) : null}

      {/* 标记摘要模块：本场标记总数 + 最近几条（服务端按场景启用时才下发数据） */}
      {mods.markers && sceneMarkers && sceneMarkers.count > 0 && (
        <MarkerSummary summary={sceneMarkers} />
      )}

      {/* 所有模块都关闭：黑场待机（仅一块极小的存活指示） */}
      {allOff && <div className="display-standby">● 待机</div>}
    </>
  );
}

// 现场标记摘要：总数 + 最近记录（最新在上）。投屏仅在当前场景启用该模块时渲染。
function MarkerSummary({ summary }) {
  const latest = [...summary.latest].reverse();
  return (
    <div className="display-markers">
      <div className="display-markers-head">现场标记 · 共 {summary.count} 条</div>
      <ul className="display-markers-list">
        {latest.map((m) => (
          <li key={m.seq} className="display-marker-item">
            <span className="display-marker-time">{formatWallTime(m.wallTime)}</span>
            <span className="display-marker-name">{m.name}</span>
            {m.itemName && <span className="display-marker-item">{m.itemName}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// 后台提示全屏覆盖层：盖住计时联播，现场人员按“确认收到”后收起
function CueOverlay({ cue, onAck }) {
  const typeLabel = {
    stage: '请上场',
    hurry: '加快',
    finish: '结束',
    custom: '后台提示',
  }[cue.cueType] || '后台提示';

  return (
    <div className={`cue-overlay cue-${cue.cueType}`}>
      <div className="cue-overlay-label">{typeLabel}</div>
      <div className="cue-overlay-text">{cue.text}</div>
      <button type="button" className="cue-ack-btn" onClick={onAck}>
        ✓ 确认收到
      </button>
      <div className="cue-overlay-hint">#{cue.cueSeq} · 控制台后台提示</div>
    </div>
  );
}

// 左下角显示名设置（持久 ID 不展示全文，悬停可见）
function ScreenNameChip({ screenRef, renameScreen }) {
  const screen = screenRef.current;
  const [nameDraft, setNameDraft] = useState(screen.name);
  const [editing, setEditing] = useState(false);

  const commit = () => {
    const name = nameDraft.trim().slice(0, 20) || screen.name;
    saveScreenName(screen.id, name);
    screen.name = name;
    setNameDraft(name);
    setEditing(false);
    renameScreen(name);
  };

  return (
    <div className="display-screen-chip" title={`屏幕 ID（刷新不变）：${screen.id}`}>
      {editing ? (
        <span className="screen-name-edit">
          <input
            autoFocus
            value={nameDraft}
            maxLength={20}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setNameDraft(screen.name); setEditing(false); }
            }}
          />
          <button type="button" className="btn btn-mini btn-primary" onClick={commit}>保存</button>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => { setNameDraft(screen.name); setEditing(false); }}
          >
            取消
          </button>
        </span>
      ) : (
        <span className="screen-name-view">
          🖥 {screen.name}
          <button type="button" className="screen-name-btn" onClick={() => setEditing(true)}>
            设置显示名
          </button>
        </span>
      )}
    </div>
  );
}

function phaseText(phase) {
  return { idle: 'READY', running: 'SPEAKING', paused: 'PAUSED', finished: 'TIME UP' }[phase] || '';
}
