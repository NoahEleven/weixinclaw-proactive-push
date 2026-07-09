/**
 * init-host-persist.cjs
 * ---------------------------------------------------------------
 * 让 WorkBuddy host (codebuddy.js) 在「收到老板微信消息」时自动把
 * ilink context_token 落盘到 send.js 读取的同一文件：
 *   <你的用户目录>/.workbuddy/claw-state/weixin/context-token.json
 *
 * 真实落盘点（经逆向确认，跨版本稳定）：
 *   weixinClawBot 入站链路（ilink bot）：
 *     1) 客户端层(getupdates 回调)把原始消息项的 eA.context_token
 *        映射进 replyContext.platformData.context_token；
 *     2) WechatChannelBridge.handleWechatMessage(eA,el) 订阅了
 *        client.onMessage，每条入站消息都会触发，并在此把
 *        platformData.context_token 存为 this.lastReplyContext.contextToken；
 *     3) 我们在 handleWechatMessage 内（this.lastReplyContext={...} 之后）
 *        插一个 IIFE 把 context_token 写盘。
 *   即：老板下次发任意一条 weixinClawBot 消息，token 自动落盘，
 *   无需 capture-token 长轮询、无需我守着测试。
 *
 * 用法：
 *   node init-host-persist.cjs            # 诊断（打印锚点/配对/预览，不改写）
 *   node init-host-persist.cjs --apply   # 注入/更新写盘逻辑（先自动备份到本目录）
 *
 * 注意：客户端版本更新会覆盖 codebuddy.js，重跑 --apply 即可（幂等替换）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_DIR = __dirname;
const HOME = os.homedir().replace(/\\/g, '/');
const CB = `${HOME}/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy.js`;
const TOKEN_DIR = `${HOME}/.workbuddy/claw-state/weixin`;
const TOKEN_FILE = `${HOME}/.workbuddy/claw-state/weixin/context-token.json`;
const MARK = "/*PERSIST_TOKEN_V2*/";

// 锚点：L679 中唯一的对象字面量开头（L691 是 chatId:el,platformData: 不同结构）
const ANCHOR = "this.lastReplyContext={chatId:ec,contextToken:";

function findCloseBrace(s, openIdx) {
  let depth = 0, i = openIdx;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function diagnose(s) {
  const count = s.split(ANCHOR).length - 1;
  console.log("锚点出现次数（应为1）:", count);
  const idx = s.indexOf(ANCHOR);
  if (idx < 0) { console.log("✗ 未找到锚点，可能版本已大改，需重新逆向"); return null; }
  const braceOpen = s.indexOf("{", idx);
  const close = findCloseBrace(s, braceOpen);
  console.log("锚点 @char:", idx, "| 对象闭合 } @char:", close);
  if (close < 0) { console.log("✗ 括号配对失败"); return null; }
  console.log("--- 注入前片段预览 ---");
  console.log(s.slice(braceOpen, close + 1).slice(0, 200));
  return { idx, braceOpen, close };
}

function buildInject() {
  // 仅在确带 context_token 时写盘，避免事件类消息把有效 token 冲成空串
  return `, (function(){try{let ct=eA.replyContext.platformData?.context_token;if(ct)require("fs").mkdirSync("${TOKEN_DIR}",{recursive:true}),require("fs").writeFileSync("${TOKEN_FILE}",JSON.stringify({context_token:String(ct),saved_at:new Date().toISOString()}))}catch(e){}})()${MARK}`;
}

// 旧注入块起点：标记前最后一个 ", (function(){try{require(\"fs\").mkdirSync(\""
const OLD_BLOCK_START = ', (function(){try{require("fs").mkdirSync("';

function apply(s) {
  const inject = buildInject();
  if (s.includes(MARK)) {
    // 幂等替换：剥离旧块后重打
    const markIdx = s.indexOf(MARK);
    const start = s.lastIndexOf(OLD_BLOCK_START, markIdx);
    if (start < 0) { console.log("✗ 找到标记但无法定位旧块起点，中止"); process.exit(2); }
    const end = markIdx + MARK.length;
    s = s.slice(0, start) + inject + s.slice(end);
    console.log("✓ 已更新为「带保护的写盘逻辑」（替换旧注入）");
  } else {
    const pos = diagnose(s);
    if (!pos) { console.log("✗ 注入中止"); process.exit(2); }
    s = s.slice(0, pos.close + 1) + inject + s.slice(pos.close + 1);
    console.log("✓ 已注入写盘逻辑");
  }
  const bak = path.join(SKILL_DIR, "codebuddy.js.bak-" + new Date().toISOString().slice(0, 10));
  fs.copyFileSync(CB, bak);
  fs.writeFileSync(CB, s);
  console.log("✓ 安全网备份:", bak);
  return s;
}

const s = fs.readFileSync(CB, "utf8");
if (process.argv.includes("--apply")) {
  apply(s);
} else {
  console.log("=== 诊断模式（不修改） ===");
  const pos = diagnose(s);
  if (pos) {
    console.log("--- 注入后预览（对象 } 之后追加） ---");
    console.log(buildInject().slice(0, 360));
  }
}
