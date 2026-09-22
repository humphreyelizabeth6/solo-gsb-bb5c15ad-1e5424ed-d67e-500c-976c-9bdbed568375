// 投屏场景编排（纯函数模块，便于单测）
//
// 模型：
//  - 持有者最多保存 8 个场景（scene），每个场景选择投屏上显示哪些模块：
//      countdown（倒计时）| agenda（议程：当前/下一环节及预计开始）
//      cue（后台提示全屏覆盖层）| markers（现场标记摘要）
//    以及布局参数：
//      theme（dark 深色 | light 浅色 | contrast 高对比）
//      size（normal 标准字号 | large 超大字号）
//      align（center 居中 | top 靠上）
//  - state.version 为场景编排的全服务单调版本：保存 / 删除 / 切换都严格递增，
//    每次递增都生成一份“完整快照”（全部场景 + 当前激活场景的完整定义）整体替换下发；
//    投屏只接受同 epoch 且 version 更高的场景快照，旧场景迟到消息一律丢弃，画面不回滚。
//  - activeId 为 null 时使用内建“默认视图”：倒计时 / 议程 / 提示三模块开启、
//    标记摘要关闭、默认布局——与引入场景编排之前的投屏行为完全一致
//    （默认视图下投屏仍不显示任何标记）。
//  - 删除当前激活场景：自动回到默认视图（activeId=null）并同样递增版本、整体广播。
//
// 场景只描述“投屏如何展示”，不持有任何业务状态：
// 计时 / 议程 / 提示 / 标记数据仍分别由既有通道下发，场景切换不触碰它们
// （因此切换期间未确认提示在服务端不可能丢失）。

export const MAX_SCENES = 8;
export const MAX_SCENE_NAME_LEN = 20;

export const MODULE_KEYS = ['countdown', 'agenda', 'cue', 'markers'];
export const SCENE_THEMES = ['dark', 'light', 'contrast'];
export const SCENE_SIZES = ['normal', 'large'];
export const SCENE_ALIGNS = ['center', 'top'];

export const DEFAULT_THEME = 'dark';
export const DEFAULT_SIZE = 'normal';
export const DEFAULT_ALIGN = 'center';

export function genSceneId() {
  return `sc-${Math.random().toString(36).slice(2, 10)}`;
}

// 内建默认视图（activeId=null）：保持场景编排上线前的投屏行为。
// 客户端在收到首个场景快照前也用同一组默认值兜底。
export function defaultScene() {
  return {
    id: null,
    name: '默认视图',
    builtin: true,
    modules: { countdown: true, agenda: true, cue: true, markers: false },
    layout: { theme: DEFAULT_THEME, size: DEFAULT_SIZE, align: DEFAULT_ALIGN },
  };
}

export function defaultSceneState() {
  // 首个发布版本即为 1（与计时快照一致）：重连/重启后首包版本严格高于
  // 客户端在 hello 时重置的基线 0，默认场景快照不会被版本守卫误丢弃。
  return { scenes: [], activeId: null, version: 1 };
}

// 校验并规范化控制台下发的单个场景。返回 { scene } 或 { error, message }。
// id：null/缺省表示新建；字符串表示更新（是否存在由 saveScene 判定）。
// 名称按用户数据严格校验；模块缺失按“未选择”处理；
// 布局枚举非法时回退默认值（不拒绝，避免界面旧枚举值导致整体保存失败）。
export function normalizeScene(raw) {
  if (!raw || typeof raw !== 'object') {
    return { error: 'BAD_SCENE', message: '场景定义必须是对象' };
  }

  const name = String(raw.name ?? '').trim();
  if (!name || name.length > MAX_SCENE_NAME_LEN) {
    return { error: 'BAD_SCENE', message: `场景名称需为 1~${MAX_SCENE_NAME_LEN} 字` };
  }

  const rawModules = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
  const modules = {};
  for (const k of MODULE_KEYS) modules[k] = !!rawModules[k];

  const rawLayout = raw.layout && typeof raw.layout === 'object' ? raw.layout : {};
  const layout = {
    theme: SCENE_THEMES.includes(rawLayout.theme) ? rawLayout.theme : DEFAULT_THEME,
    size: SCENE_SIZES.includes(rawLayout.size) ? rawLayout.size : DEFAULT_SIZE,
    align: SCENE_ALIGNS.includes(rawLayout.align) ? rawLayout.align : DEFAULT_ALIGN,
  };

  let id = null;
  if (raw.id != null) {
    const sid = String(raw.id);
    if (!/^sc-[\w.-]{1,64}$/.test(sid)) {
      return { error: 'BAD_SCENE', message: '场景 ID 非法' };
    }
    id = sid;
  }

  return { scene: { id, name: name.slice(0, MAX_SCENE_NAME_LEN), modules, layout } };
}

// 保存（新建或整体更新）一个场景。任何成功保存都递增版本：
// 若保存的正是当前激活场景，投屏会立即按新定义整体替换。
export function saveScene(state, raw) {
  const result = normalizeScene(raw);
  if (result.error) return result;
  const draft = result.scene;

  if (draft.id) {
    const idx = state.scenes.findIndex((s) => s.id === draft.id);
    if (idx === -1) {
      return { error: 'NOT_FOUND', message: '场景不存在（可能已被删除）' };
    }
    const scenes = state.scenes.slice();
    scenes[idx] = { ...draft, id: draft.id };
    const next = { ...state, scenes, version: state.version + 1 };
    return { ok: true, state: next, scene: scenes[idx], created: false };
  }

  if (state.scenes.length >= MAX_SCENES) {
    return { error: 'SCENE_LIMIT', message: `最多保存 ${MAX_SCENES} 个场景` };
  }
  const created = { ...draft, id: genSceneId() };
  const next = { ...state, scenes: [...state.scenes, created], version: state.version + 1 };
  return { ok: true, state: next, scene: created, created: true };
}

// 删除场景；删除的正是当前激活场景时自动回到默认视图。
export function deleteScene(state, rawId) {
  const id = String(rawId ?? '');
  if (!state.scenes.some((s) => s.id === id)) {
    return { error: 'NOT_FOUND', message: '场景不存在（可能已被删除）' };
  }
  const scenes = state.scenes.filter((s) => s.id !== id);
  const activeId = state.activeId === id ? null : state.activeId;
  return { ok: true, state: { ...state, scenes, activeId, version: state.version + 1 } };
}

// 切换当前激活场景：rawId 为 null/空串表示回到内建默认视图。
// 重复激活同一场景也递增版本（用于让各屏重新整体替换并重新确认）。
export function activateScene(state, rawId) {
  if (rawId == null || rawId === '') {
    return { ok: true, state: { ...state, activeId: null, version: state.version + 1 } };
  }
  const id = String(rawId);
  if (!state.scenes.some((s) => s.id === id)) {
    return { error: 'NOT_FOUND', message: '场景不存在（可能已被删除）' };
  }
  return { ok: true, state: { ...state, activeId: id, version: state.version + 1 } };
}

// 当前激活场景的完整定义（找不到时回退默认视图，保证投屏总有权威定义可用）。
export function activeSceneOf(state) {
  return state.scenes.find((s) => s.id === state.activeId) ?? defaultScene();
}

// 投屏确认版本是否落后：用于控制台展示各屏“已确认 / 待确认”。
// 离线/重连尚未重新确认时 appliedVersion 为 0。
export function screenAckStatus(screen, activeVersion) {
  if (!screen.online) return 'offline';
  return (screen.sceneVersion ?? 0) >= activeVersion ? 'acked' : 'pending';
}
