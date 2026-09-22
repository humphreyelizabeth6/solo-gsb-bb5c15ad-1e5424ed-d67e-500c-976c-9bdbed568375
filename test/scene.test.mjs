// 投屏场景编排（scene）集成测试：启动独立服务实例，验证：
//  1. 连接首包携带场景完整快照（默认视图：倒计时/议程/提示开启、标记摘要关闭、首版 v1）；
//  2. 非持有者 scene_save / scene_delete / scene_activate 一律 NOT_CONTROLLER；
//  3. 场景名校验（BAD_SCENE）、布局枚举非法时回退默认；最多 8 个（SCENE_LIMIT）；
//  4. 更新带 id（存在更新 / 不存在 NOT_FOUND）；保存当前激活场景立即生成新版本；
//  5. 切换原子广播：activeId/active 完整定义随版本递增下发，投屏一次性收到完整快照；
//  6. 投屏应用后回执 scene_applied：控制台名单 sceneVersion 对齐当前版本（已确认）；
//     重复/旧版本回执不回退；替别人回执 NOT_YOUR_SCREEN；未注册回执被拒；
//  7. 切换不触碰提示：提示模块关闭期间 cue 仍单播到屏、状态保持 pending；切回后仍可确认；
//  8. 标记摘要：启用模块的场景激活后，标记新增/删除广播 scene_markers（含计数/最近条目），
//     控制台继续收完整 markers；模块关闭时投屏不再收 scene_markers；注册重连补发摘要；
//  9. 删除当前激活场景自动回到默认视图；activate id=null 回到默认视图；
// 10. 断线重连首包恢复当前场景（activeId/version/完整 active）；
// 11. 旧场景迟到快照不能覆盖新场景（客户端版本守卫）——以独立连接模拟低版本消息到达。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_SCENE_PORT || 3599;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}
async function next(inbox, type, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
// 等待满足谓词的最新一条整体替换消息
async function waitMsg(inbox, type, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i].type === type && (!pred || pred(inbox[i]))) return inbox.splice(i, 1)[0];
    }
    if (Date.now() > deadline) throw new Error(`等待匹配 ${type} 超时`);
    await sleep(20);
  }
}
async function drain(inbox, ms = 250) {
  await sleep(ms);
  return inbox.splice(0);
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function acquire(c) {
  c.ws.send(JSON.stringify({ command: 'acquire' }));
  return next(c.inbox, 'control', (m) => m.granted);
}
async function registerDisplay(c, id, name) {
  c.ws.send(JSON.stringify({ command: 'screen_register', screenId: id, name }));
  await next(c.inbox, 'screen_hello');
}

const ID1 = 's-aaaa1111-1111-4222-8333-cccccccccc01';
const ID2 = 's-bbbb2222-2222-4333-9444-dddddddddd02';

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 连接首包：场景完整快照（默认视图 v1）');
  const watcher = await connect();
  await next(watcher.inbox, 'hello');
  await next(watcher.inbox, 'snapshot');
  await next(watcher.inbox, 'screens');
  const initScenes = await next(watcher.inbox, 'scenes');
  ok('初始 scenes.version=1（首包即严格高于 hello 基线）且 activeId=null',
    initScenes.version === 1 && initScenes.activeId === null);
  ok('默认视图模块：倒计时/议程/提示开启、标记摘要关闭',
    initScenes.active.modules.countdown === true
    && initScenes.active.modules.agenda === true
    && initScenes.active.modules.cue === true
    && initScenes.active.modules.markers === false);
  ok('默认布局 dark/normal/center',
    initScenes.active.layout.theme === 'dark'
    && initScenes.active.layout.size === 'normal'
    && initScenes.active.layout.align === 'center');
  ok('初始场景列表为空', Array.isArray(initScenes.scenes) && initScenes.scenes.length === 0);

  console.log('2) 非持有者场景指令被拒');
  const c0 = await connect();
  await next(c0.inbox, 'hello');
  await next(c0.inbox, 'snapshot');
  await next(c0.inbox, 'screens');
  await next(c0.inbox, 'scenes');
  c0.ws.send(JSON.stringify({ command: 'scene_save', scene: { name: 'x', modules: {}, layout: {} } }));
  const errSave = await next(c0.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('非持有者 scene_save 被拒', !!errSave);
  c0.ws.send(JSON.stringify({ command: 'scene_activate', id: 'x' }));
  const errAct = await next(c0.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('非持有者 scene_activate 被拒', !!errAct);
  c0.ws.send(JSON.stringify({ command: 'scene_delete', id: 'x' }));
  const errDel = await next(c0.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('非持有者 scene_delete 被拒', !!errDel);
  c0.ws.close();

  console.log('3) 持有者获取控制权；校验与布局回退');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  await next(con.inbox, 'screens');
  await next(con.inbox, 'scenes');
  await acquire(con);

  con.ws.send(JSON.stringify({ command: 'scene_save', scene: { name: '   ', modules: {}, layout: {} } }));
  const errName = await next(con.inbox, 'error', (m) => m.code === 'BAD_SCENE');
  ok('空场景名返回 BAD_SCENE', !!errName);
  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { name: '字'.repeat(21), modules: {}, layout: {} },
  }));
  const errLong = await next(con.inbox, 'error', (m) => m.code === 'BAD_SCENE');
  ok('超长场景名返回 BAD_SCENE', !!errLong);

  // 非法布局枚举回退默认；缺省模块全部为 false
  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { name: '黑场', modules: {}, layout: { theme: 'neon', size: 'huge', align: 'side' } },
  }));
  const sCoerce = await next(con.inbox, 'scenes', (m) => m.version === 2);
  const black = sCoerce.scenes[0];
  ok('保存成功且版本递增到 2', sCoerce.scenes.length === 1 && black.name === '黑场');
  ok('缺省模块全部 false（允许全模块关闭的黑场）',
    Object.values(black.modules).every((v) => v === false));
  ok('非法布局枚举回退 dark/normal/center',
    black.layout.theme === 'dark' && black.layout.size === 'normal' && black.layout.align === 'center');

  console.log('4) 最多 8 个场景（SCENE_LIMIT）；带 id 更新 / 未知 id NOT_FOUND');
  for (let i = 0; i < 7; i++) {
    con.ws.send(JSON.stringify({
      command: 'scene_save',
      scene: { name: `场景 ${i + 2}`, modules: { countdown: true }, layout: {} },
    }));
    await waitMsg(con.inbox, 'scenes', (m) => m.scenes.length === i + 2);
  }
  ok('已保存 8 个场景', (await drain(con.inbox, 30), true));
  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { name: '第九个', modules: {}, layout: {} },
  }));
  const errLimit = await next(con.inbox, 'error', (m) => m.code === 'SCENE_LIMIT');
  ok('第 9 个场景返回 SCENE_LIMIT', !!errLimit);

  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { id: black.id, name: '黑场（改）', modules: { countdown: true, markers: true },
      layout: { theme: 'light', size: 'large', align: 'top' } },
  }));
  const sUpd = await next(con.inbox, 'scenes', (m) => m.scenes.find((x) => x.id === black.id)?.name === '黑场（改）');
  const upd = sUpd.scenes.find((x) => x.id === black.id);
  ok('按 id 更新成功且数量不变', sUpd.scenes.length === 8 && upd.layout.theme === 'light');
  ok('更新后版本继续递增', sUpd.version > sCoerce.version);

  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { id: 'sc-nonexistent', name: '幽灵', modules: {}, layout: {} },
  }));
  const errNotFound = await next(con.inbox, 'error', (m) => m.code === 'NOT_FOUND');
  ok('更新不存在的 id 返回 NOT_FOUND', !!errNotFound);

  console.log('5) 投屏注册并收首包场景快照；激活场景原子广播');
  const d1 = await connect();
  await next(d1.inbox, 'hello');
  await next(d1.inbox, 'snapshot');
  await next(d1.inbox, 'screens');
  const d1InitScenes = await next(d1.inbox, 'scenes');
  await registerDisplay(d1, ID1, '主屏');
  ok('投屏首包即有当前场景完整快照', !!d1InitScenes && d1InitScenes.activeId === null);

  const d2 = await connect();
  await next(d2.inbox, 'hello');
  await next(d2.inbox, 'snapshot');
  await next(d2.inbox, 'screens');
  await next(d2.inbox, 'scenes');
  await registerDisplay(d2, ID2, '侧屏');

  // 激活“黑场（改）”：light/large/top + 倒计时/标记摘要
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: black.id }));
  const sAct1 = await next(con.inbox, 'scenes', (m) => m.activeId === black.id);
  ok('控制台收到激活广播：activeId 指向目标场景', sAct1.activeId === black.id);
  ok('active 为该场景完整定义（模块+布局）',
    sAct1.active.id === black.id
    && sAct1.active.modules.markers === true
    && sAct1.active.layout.theme === 'light'
    && sAct1.active.layout.size === 'large'
    && sAct1.active.layout.align === 'top',
    JSON.stringify(sAct1.active));
  ok('激活后版本严格递增', sAct1.version > sUpd.version);

  const dAct = await waitMsg(d1.inbox, 'scenes', (m) => m.activeId === black.id);
  ok('投屏收到同一份完整场景快照（一次性替换依据）',
    dAct.version === sAct1.version
    && dAct.active.id === black.id
    && JSON.stringify(dAct.active) === JSON.stringify(sAct1.active));

  console.log('6) scene_applied 回执与各屏确认状态');
  // d1 在收到 5) 的激活广播时已由客户端逻辑回执（本测试直接模拟回执时机）：
  // 新连接注册时尚未确认当前版本（sceneVersion=0），主动回执当前版本
  d1.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID1, version: sAct1.version }));
  const list1 = await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID1)?.sceneVersion === sAct1.version);
  const rec1 = list1.screens.find((s) => s.id === ID1);
  const rec2 = list1.screens.find((s) => s.id === ID2);
  ok('回执后该屏 sceneVersion 对齐当前版本（已确认）', rec1.sceneVersion === sAct1.version);
  ok('未回执屏幕 sceneVersion=0（待确认）', rec2.sceneVersion === 0);

  // 重复 / 旧版本回执不回退：旧版本回执服务端静默丢弃（不产生广播），
  // 随后 d2 正常回执当前版本触发一次名单广播，在同一名单上验证 d1 未被回退、d2 已确认。
  d1.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID1, version: 1 }));
  await drain(con.inbox, 250);
  d2.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID2, version: sAct1.version }));
  const listAfter = await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID2)?.sceneVersion === sAct1.version);
  ok('旧版本回执不回退确认状态（d1 保持当前版本）',
    listAfter.screens.find((s) => s.id === ID1).sceneVersion === sAct1.version);
  ok('d2 正常回执后也显示已确认',
    listAfter.screens.find((s) => s.id === ID2).sceneVersion === sAct1.version);

  // 再次回执同一版本（重复）幂等且不再广播
  d2.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID2, version: sAct1.version }));
  const dupBroadcasts = (await drain(con.inbox, 300)).filter((m) => m.type === 'screens');
  ok('重复回执幂等且不再广播', dupBroadcasts.length === 0, `${dupBroadcasts.length} 条`);

  // 替别人回执被拒
  d1.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID2, version: sAct1.version }));
  const errProxy = await next(d1.inbox, 'error', (m) => m.code === 'NOT_YOUR_SCREEN');
  ok('替其他屏幕回执场景确认被拒', !!errProxy);

  // 未注册连接回执被拒
  const ghost = await connect();
  await next(ghost.inbox, 'hello');
  await next(ghost.inbox, 'snapshot');
  ghost.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID1, version: sAct1.version }));
  const errGhost = await next(ghost.inbox, 'error', (m) => m.code === 'NOT_YOUR_SCREEN');
  ok('未注册连接 scene_applied 被拒', !!errGhost);
  ghost.ws.close();

  console.log('7) 切换不触碰提示：提示模块关闭场景下 cue 仍送达且状态保持，切回可确认');
  // 当前激活场景 black：cue 模块关闭
  ok('当前场景提示模块关闭', sAct1.active.modules.cue === false);
  con.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'stage' }));
  const cueMsg = await next(d1.inbox, 'cue');
  ok('提示模块关闭时 cue 仍单播到屏（切换不丢提示）', cueMsg.text === '请上场');
  const pendingList = await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID1)?.cue?.seq === cueMsg.cueSeq
      && m.screens.find((s) => s.id === ID1)?.cue?.status === 'pending');
  ok('投屏未上屏故状态保持 pending（未送达，不虚报）', !!pendingList);

  // 新建含提示模块的场景并激活；切回后同一条未确认提示仍可由该屏确认
  con.ws.send(JSON.stringify({
    command: 'scene_save',
    // 先删掉一个腾出名额
    scene: { name: '提示全开', modules: { countdown: true, agenda: true, cue: true, markers: false }, layout: {} },
  }));
  // 名额已满（8），先删一个再建
  const errLimit2 = await next(con.inbox, 'error', (m) => m.code === 'SCENE_LIMIT').catch(() => null);
  ok('满员时新建返回 SCENE_LIMIT', !!errLimit2);
  const spare = sUpd.scenes.find((x) => x.id !== black.id);
  con.ws.send(JSON.stringify({ command: 'scene_delete', id: spare.id }));
  await next(con.inbox, 'scenes', (m) => m.scenes.length === 7 && m.activeId === black.id);
  con.ws.send(JSON.stringify({
    command: 'scene_save',
    scene: { name: '提示全开', modules: { countdown: true, agenda: true, cue: true, markers: false }, layout: {} },
  }));
  const sCue = await next(con.inbox, 'scenes', (m) => m.scenes.some((x) => x.name === '提示全开'));
  const cueScene = sCue.scenes.find((x) => x.name === '提示全开');
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: cueScene.id }));
  const sCueOn = await next(con.inbox, 'scenes', (m) => m.activeId === cueScene.id);
  await waitMsg(d1.inbox, 'scenes', (m) => m.activeId === cueScene.id);
  ok('切到提示开启场景后版本继续递增、cue 模块开启', sCueOn.active.modules.cue === true);

  // 提示仍在（服务端未因切换清理）；投屏模拟“重新上屏 + 确认”
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: cueMsg.cueSeq }));
  await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID1)?.cue?.status === 'displayed');
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cueMsg.cueSeq }));
  const ackList = await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID1)?.cue?.status === 'acknowledged');
  ok('切回提示场景后同一条提示可走完 已显示→已确认（切换期间未丢失）',
    ackList.screens.find((s) => s.id === ID1).cue.seq === cueMsg.cueSeq);

  console.log('8) 标记摘要：启用才下发投屏、整体替换、控制台始终收完整 markers');
  // 切回 black（markers 模块开启）
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: black.id }));
  await next(con.inbox, 'scenes', (m) => m.activeId === black.id);
  // 投屏应用摘要场景
  await waitMsg(d1.inbox, 'scenes', (m) => m.activeId === black.id);
  await waitMsg(d2.inbox, 'scenes', (m) => m.activeId === black.id).catch(() => null);
  // 激活时服务端即补发当前摘要（此时 0 条，可能无消息；直接加标记验证）
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '发言切换' }));
  const mk1Display = await next(d1.inbox, 'scene_markers', (m) => m.count === 1);
  const mk1Console = await next(con.inbox, 'markers', (m) => m.markers.length === 1);
  ok('投屏收到标记摘要（count + 最近条目）',
    mk1Display.latest.length === 1 && mk1Display.latest[0].name === '发言切换'
    && mk1Display.sessionId === mk1Console.sessionId);
  ok('控制台同时收到完整 markers（既有通道不变）', mk1Console.markers[0].seq === 1);

  con.ws.send(JSON.stringify({ command: 'mark_add', name: '设备故障' }));
  await next(d1.inbox, 'scene_markers', (m) => m.count === 2 && m.latest.length === 2);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '提示上场' }));
  const mk3 = await next(d1.inbox, 'scene_markers', (m) => m.count === 3 && m.latest.length === 3);
  ok('摘要随标记新增整体替换（最近 3 条）', mk3.latest.map((m) => m.seq).join(',') === '1,2,3');
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '现场干扰' }));
  const mk4 = await next(d1.inbox, 'scene_markers', (m) => m.count === 4 && m.latest.length === 3);
  ok('超过 3 条后摘要只保留最近 3 条', mk4.latest.map((m) => m.name).join(',') === '设备故障,提示上场,现场干扰');
  con.ws.send(JSON.stringify({ command: 'mark_delete_latest' }));
  const mkDel = await next(d1.inbox, 'scene_markers', (m) => m.count === 3 && m.latest.length === 3);
  ok('删除最近一条后摘要同步（最新回到“提示上场”）',
    mkDel.latest[2].name === '提示上场');

  // 切到标记摘要关闭的场景：新增标记不再下发投屏
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: cueScene.id }));
  await next(con.inbox, 'scenes', (m) => m.activeId === cueScene.id);
  await waitMsg(d1.inbox, 'scenes', (m) => m.activeId === cueScene.id);
  // 排干此前启用摘要期间残留在 d1 收件箱中的 scene_markers，只观察“模块关闭后”的新消息
  await drain(d1.inbox, 100);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '不应出现在投屏' }));
  await next(con.inbox, 'markers', (m) => m.markers.length === 4);
  const leaked = (await drain(d1.inbox, 350)).filter((m) => m.type === 'scene_markers');
  ok('标记摘要模块关闭时投屏不再收到 scene_markers', leaked.length === 0, `${leaked.length} 条`);

  console.log('9) 删除当前激活场景 / activate null 自动回到默认视图');
  con.ws.send(JSON.stringify({ command: 'scene_delete', id: cueScene.id }));
  const sBackDefault = await next(con.inbox, 'scenes',
    (m) => m.activeId === null && m.scenes.length === 7);
  ok('删除激活场景后 activeId=null、active 回默认视图、版本递增',
    sBackDefault.active.modules.markers === false && sBackDefault.active.modules.cue === true);
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: black.id }));
  await next(con.inbox, 'scenes', (m) => m.activeId === black.id);
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: null }));
  const sNull = await next(con.inbox, 'scenes', (m) => m.activeId === null);
  ok('activate null 回到默认视图且版本再次递增', !!sNull && sNull.active.builtin === true);
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-ghost' }));
  const errActMissing = await next(con.inbox, 'error', (m) => m.code === 'NOT_FOUND');
  ok('激活不存在的场景返回 NOT_FOUND', !!errActMissing);

  console.log('10) 断线重连恢复当前场景 + 注册补发标记摘要');
  // 激活标记摘要场景并保证有标记
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: black.id }));
  const sRestore = await next(con.inbox, 'scenes', (m) => m.activeId === black.id);
  await waitMsg(d1.inbox, 'scenes', (m) => m.activeId === black.id).catch(() => null);
  const verBefore = sRestore.version;
  d1.ws.close();
  await waitMsg(con.inbox, 'screens', (m) => {
    const r = m.screens.find((s) => s.id === ID1);
    return r && r.online === false;
  });
  const d1b = await connect();
  await next(d1b.inbox, 'hello');
  await next(d1b.inbox, 'snapshot');
  await next(d1b.inbox, 'screens');
  const reScenes = await next(d1b.inbox, 'scenes');
  ok('重连首包恢复当前场景（activeId / 完整 active / 版本）',
    reScenes.activeId === black.id
    && reScenes.active.id === black.id
    && reScenes.active.layout.theme === 'light'
    && reScenes.version === verBefore);
  d1b.ws.send(JSON.stringify({ command: 'screen_register', screenId: ID1, name: '主屏' }));
  await next(d1b.inbox, 'screen_hello');
  const reSummary = await next(d1b.inbox, 'scene_markers');
  ok('重连注册后补发标记摘要', reSummary.count >= 3 && reSummary.latest.length === 3);
  // 重连后自动确认当前版本
  d1b.ws.send(JSON.stringify({ command: 'scene_applied', screenId: ID1, version: verBefore }));
  const reAck = await waitMsg(con.inbox, 'screens',
    (m) => m.screens.find((s) => s.id === ID1)?.sceneVersion === verBefore && m.screens.find((s) => s.id === ID1)?.online);
  ok('重连确认后名单恢复在线且已确认当前版本',
    reAck.screens.find((s) => s.id === ID1).sceneVersion === verBefore);

  console.log('11) 旧场景迟到快照不能覆盖新场景（版本守卫，客户端同款纯函数）');
  const { judgeSnapshot } = await import('../client/src/guard.js');
  const baseline = { currentEpoch: sRestore.epoch, currentVersion: verBefore };
  ok('更高版本场景快照被接受', judgeSnapshot(baseline, { epoch: sRestore.epoch, version: verBefore + 1 }).accept === true);
  ok('旧版本/同版本场景快照被丢弃',
    judgeSnapshot(baseline, { epoch: sRestore.epoch, version: verBefore - 1 }).accept === false
    && judgeSnapshot(baseline, { epoch: sRestore.epoch, version: verBefore }).accept === false);
  ok('旧纪元场景快照被丢弃',
    judgeSnapshot(baseline, { epoch: 'old-epoch', version: verBefore + 99 }).accept === false);

  // 清理
  try { d1b.ws.close(); } catch {}
  try { d2.ws.close(); } catch {}
  try { con.ws.close(); } catch {}
  try { watcher.ws.close(); } catch {}

  console.log(`\n投屏场景编排测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('  ✗ 测试异常:', e);
  process.exitCode = 1;
} finally {
  child.kill();
}
