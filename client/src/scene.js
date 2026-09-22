// 投屏场景编排：客户端常量与派生工具
// 默认视图与服务端 server/src/scene.js 的 defaultScene 保持一致（客户端无法
// 直接引用服务端模块：Docker 构建客户端时服务端源码尚未复制进构建上下文）。
export const DEFAULT_SCENE = Object.freeze({
  id: null,
  name: '默认视图',
  builtin: true,
  modules: Object.freeze({ countdown: true, agenda: true, cue: true, markers: false }),
  layout: Object.freeze({ theme: 'dark', size: 'normal', align: 'center' }),
});

export const MODULE_LABELS = Object.freeze({
  countdown: '倒计时',
  agenda: '议程',
  cue: '提示',
  markers: '标记摘要',
});

export const MODULE_KEYS = ['countdown', 'agenda', 'cue', 'markers'];

export const THEME_OPTIONS = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'contrast', label: '高对比' },
];

export const SIZE_OPTIONS = [
  { value: 'normal', label: '标准字号' },
  { value: 'large', label: '超大字号' },
];

export const ALIGN_OPTIONS = [
  { value: 'center', label: '居中' },
  { value: 'top', label: '靠上' },
];

// 取场景编排快照中的当前激活场景；首包到达前用默认视图兜底（行为同上线前）。
export function activeScene(scenes) {
  const active = scenes?.active;
  if (!active || !active.modules || !active.layout) return DEFAULT_SCENE;
  return active;
}

export function layoutSummary(layout) {
  const theme = THEME_OPTIONS.find((o) => o.value === layout?.theme)?.label ?? '深色';
  const size = SIZE_OPTIONS.find((o) => o.value === layout?.size)?.label ?? '标准字号';
  const align = ALIGN_OPTIONS.find((o) => o.value === layout?.align)?.label ?? '居中';
  return `${theme} · ${size} · ${align}`;
}
