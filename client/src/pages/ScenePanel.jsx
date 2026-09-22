import { useEffect, useState } from 'react';
import {
  MODULE_LABELS,
  MODULE_KEYS,
  THEME_OPTIONS,
  SIZE_OPTIONS,
  ALIGN_OPTIONS,
  layoutSummary,
} from '../scene.js';

const MAX_NAME_LEN = 20;
const MAX_SCENES = 8;

const SCENE_ERROR_CODES = new Set(['BAD_SCENE', 'SCENE_LIMIT', 'NOT_FOUND']);

function blankDraft() {
  return {
    name: '',
    modules: { countdown: true, agenda: true, cue: true, markers: false },
    layout: { theme: 'dark', size: 'normal', align: 'center' },
  };
}

// 控制台“投屏场景编排”面板：
//  - 持有者最多保存 8 个场景，逐场景勾选倒计时 / 议程 / 提示 / 标记摘要模块并设置布局；
//  - 保存 / 删除 / 切换都由服务端按单调版本生成完整快照并原子广播，投屏一次性整体替换；
//  - 面板逐屏展示对当前版本的确认状态：已确认 / 待确认 / 离线；
//  - 场景只决定投屏如何展示，切换不触碰计时/议程/提示/标记（未确认提示不丢失）。
export default function ScenePanel({ scenes, screens, canEdit, send, lastError, onClearError }) {
  const list = scenes?.scenes ?? [];
  const activeId = scenes?.activeId ?? null;
  const activeVersion = scenes?.version ?? 0;
  const activeName = scenes?.active?.name ?? '默认视图';

  const [draft, setDraft] = useState(blankDraft);
  const [editingId, setEditingId] = useState(null); // 正在编辑的场景 id；null=新建
  const [formError, setFormError] = useState('');

  // 服务端错误（BAD_SCENE / SCENE_LIMIT / NOT_FOUND）展示 5 秒
  const sceneError = lastError && SCENE_ERROR_CODES.has(lastError.code);
  useEffect(() => {
    if (!sceneError || !onClearError) return undefined;
    const t = setTimeout(onClearError, 5000);
    return () => clearTimeout(t);
  }, [sceneError, onClearError]);

  const setModule = (key, on) => {
    setDraft((d) => ({ ...d, modules: { ...d.modules, [key]: on } }));
  };
  const setLayout = (key, value) => {
    setDraft((d) => ({ ...d, layout: { ...d.layout, [key]: value } }));
  };

  const startEdit = (sc) => {
    setEditingId(sc.id);
    setDraft({
      name: sc.name,
      modules: { ...sc.modules },
      layout: { ...sc.layout },
    });
    setFormError('');
  };

  const startCreate = () => {
    setEditingId(''); // 进入“新建”编辑态（与 null=未编辑区分）
    setDraft(blankDraft());
    setFormError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormError('');
  };

  const save = () => {
    const name = draft.name.trim();
    if (!name || name.length > MAX_NAME_LEN) {
      setFormError(`场景名称需为 1~${MAX_NAME_LEN} 字`);
      return;
    }
    const payload = {
      name,
      modules: { ...draft.modules },
      layout: { ...draft.layout },
    };
    if (editingId) payload.id = editingId;
    send({ command: 'scene_save', scene: payload });
    setEditingId(null);
    setDraft(blankDraft());
    setFormError('');
  };

  const remove = (id) => {
    send({ command: 'scene_delete', id });
    if (editingId === id) cancelEdit();
  };

  const activate = (id) => send({ command: 'scene_activate', id });

  const onCount = list.length;
  const editing = editingId !== null;
  const activeMods = scenes?.active?.modules;

  return (
    <fieldset className="panel scene-panel" disabled={!canEdit}>
      <legend>
        投屏场景编排（最多 {MAX_SCENES} 个场景；按版本原子广播切换，投屏一次性整体替换）
      </legend>

      <div className="scene-current">
        <span className="scene-current-label">当前投屏</span>
        <span className="scene-current-name">{activeName}</span>
        <em className="tag tag-now">v{activeVersion}</em>
        {activeMods && (
          <span className="scene-current-mods">
            {MODULE_KEYS.map((k) => (
              <em key={k} className={`scene-mod-pill ${activeMods[k] ? 'scene-mod-on' : 'scene-mod-off'}`}>
                {MODULE_LABELS[k]}
              </em>
            ))}
          </span>
        )}
      </div>

      {/* 场景清单（含内建默认视图） */}
      <div className="scene-list">
        <div className="scene-row scene-row-head">
          <span>场景</span>
          <span>模块</span>
          <span>布局</span>
          <span>操作</span>
        </div>

        <SceneRow
          name="默认视图"
          builtin
          active={activeId === null}
          modules={{ countdown: true, agenda: true, cue: true, markers: false }}
          layoutText="深色 · 标准字号 · 居中"
          canEdit={canEdit}
          onActivate={() => activate(null)}
        />

        {list.map((sc) => (
          <SceneRow
            key={sc.id}
            name={sc.name}
            active={sc.id === activeId}
            modules={sc.modules}
            layoutText={layoutSummary(sc.layout)}
            canEdit={canEdit}
            onActivate={() => activate(sc.id)}
            onEdit={() => startEdit(sc)}
            onDelete={() => remove(sc.id)}
          />
        ))}
      </div>

      {/* 编辑器：新建 / 更新 */}
      {editing ? (
        <div className="scene-editor">
          <div className="scene-editor-title">{editingId ? '更新场景' : '新建场景'}</div>
          <div className="scene-form-row">
            <label className="scene-name-field">
              场景名称
              <input
                value={draft.name}
                maxLength={MAX_NAME_LEN}
                placeholder={`1~${MAX_NAME_LEN} 字，如：开幕式主屏`}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.slice(0, MAX_NAME_LEN) }))}
              />
            </label>
            <span className="cue-counter">{draft.name.trim().length}/{MAX_NAME_LEN}</span>
          </div>

          <div className="scene-form-row">
            <span className="scene-field-label">投屏模块</span>
            <div className="scene-module-picks">
              {MODULE_KEYS.map((k) => (
                <label key={k} className={`scene-module-pick ${draft.modules[k] ? 'scene-module-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!!draft.modules[k]}
                    onChange={(e) => setModule(k, e.target.checked)}
                  />
                  {MODULE_LABELS[k]}
                </label>
              ))}
            </div>
          </div>

          <div className="scene-form-row scene-layout-row">
            <label>
              主题
              <select value={draft.layout.theme} onChange={(e) => setLayout('theme', e.target.value)}>
                {THEME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              字号
              <select value={draft.layout.size} onChange={(e) => setLayout('size', e.target.value)}>
                {SIZE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              垂直位置
              <select value={draft.layout.align} onChange={(e) => setLayout('align', e.target.value)}>
                {ALIGN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <div className="scene-actions">
            <button type="button" className="btn btn-primary" onClick={save}>
              {editingId ? '保存更新（立即同步投屏）' : '保存场景'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={cancelEdit}>取消</button>
          </div>
          {!draft.modules.countdown && !draft.modules.agenda && !draft.modules.cue && !draft.modules.markers && (
            <p className="hint hint-warn">四个模块均关闭时为“黑场待机”画面（仅保留极小待机指示）。</p>
          )}
          {!draft.modules.cue && (
            <p className="hint">提示模块关闭时，未确认提示在服务端与投屏端暂挂保留，切回含提示模块的场景后复显，不会丢失。</p>
          )}
        </div>
      ) : (
        <div className="scene-actions">
          <button type="button" className="btn" disabled={!canEdit || onCount >= MAX_SCENES} onClick={startCreate}>
            ＋ 新建场景（{onCount}/{MAX_SCENES}）
          </button>
        </div>
      )}

      {(formError || sceneError) && (
        <p className="agenda-error">⚠ {formError || lastError.message}</p>
      )}

      {/* 各屏对当前场景版本的确认状态 */}
      <div className="scene-acks">
        <div className="scene-acks-head">各屏确认状态（当前场景版本 v{activeVersion}）</div>
        {screens.length === 0 ? (
          <p className="hint">尚无投屏注册。在大屏浏览器打开 /display 后，这里会逐屏显示确认状态。</p>
        ) : (
          <div className="scene-ack-list">
            {screens.map((s) => {
              const acked = (s.sceneVersion ?? 0) >= activeVersion;
              return (
                <div key={s.id} className={`scene-ack-row ${s.online ? '' : 'cue-row-offline'}`}>
                  <span className="cue-screen-name">🖥 {s.name}</span>
                  {!s.online ? (
                    <em className="tag cue-tag-offline">离线</em>
                  ) : acked ? (
                    <em className="tag cue-status-acknowledged">已确认 v{s.sceneVersion}</em>
                  ) : (
                    <em className="tag cue-status-pending">待确认（v{s.sceneVersion} → v{activeVersion}）</em>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="hint">
        场景只决定投屏的模块与布局：保存/切换后服务端按新版本生成完整快照并原子广播，
        投屏收到后一次性替换；旧场景迟到消息按版本丢弃，断线重连首包即恢复当前场景。
        标记摘要仅在场景启用时下发给投屏，默认视图不显示任何标记。
      </p>
    </fieldset>
  );
}

function SceneRow({
  name, builtin = false, active, modules, layoutText, canEdit,
  onActivate, onEdit, onDelete,
}) {
  return (
    <div className={`scene-row ${active ? 'scene-row-active' : ''}`}>
      <span className="scene-name-cell">
        <span className="scene-name-text">{name}</span>
        {builtin && <em className="tag tag-done">内建</em>}
        {active && <em className="tag tag-now">投屏中</em>}
      </span>
      <span className="scene-mods-cell">
        {MODULE_KEYS.map((k) => (
          <em
            key={k}
            className={`scene-mod-pill ${modules[k] ? 'scene-mod-on' : 'scene-mod-off'}`}
            title={modules[k] ? `${MODULE_LABELS[k]}：显示` : `${MODULE_LABELS[k]}：隐藏`}
          >
            {MODULE_LABELS[k]}
          </em>
        ))}
      </span>
      <span className="scene-layout-cell">{layoutText}</span>
      <span className="scene-ops">
        <button
          type="button"
          className="btn btn-mini btn-primary"
          disabled={!canEdit || active}
          onClick={onActivate}
          title={active ? '该场景正在投屏' : '原子切换：服务端广播完整快照，各屏一次性替换后回确认'}
        >
          {active ? '投屏中' : '启用'}
        </button>
        {!builtin && (
          <>
            <button type="button" className="btn btn-mini" disabled={!canEdit} onClick={onEdit}>编辑</button>
            <button type="button" className="btn btn-mini btn-danger" disabled={!canEdit} onClick={onDelete}>删</button>
          </>
        )}
      </span>
    </div>
  );
}
