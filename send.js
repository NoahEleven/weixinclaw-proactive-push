#!/usr/bin/env node
/**
 * weixinclaw-proactive-push/send.js
 *
 * 通过 WorkBuddy 已连接的 ClawBot 微信 bot 通道（weixinClawBot / ilink bot，非微信客服号）
 * 主动向老板微信推送消息：文本 / 图片 / 文件 / 视频。
 *
 * 协议严格对齐腾讯官方插件 @tencent-weixin/openclaw-weixin@2.4.6（src/cdn + src/messaging + src/api）。
 *
 * 【关键机制：context_token（实测结论，2026-07-08 修正）】
 *   - 经实测：文本 / 图片 / 文件 / 视频 的主动推送，服务端【均】强制要求有效 context_token。
 *     传空串或省略该字段 => 统一返回 ret:-2 拒收（并非只有媒体才需要）。
 *   - 之前 17:37 文本/.txt 能收到，是因为彼时老板刚在对话、处于服务器宽松窗口；
 *     长时间无交互后空 token 即被拒（ret:-2）。
 *   - 有效 context_token 只在「老板给 bot 发过消息」后由服务端随 getUpdates 下发；
 *     本脚本通过 getUpdates 长轮询捕获并持久化到
 *     ~/.workbuddy/claw-state/weixin/context-token.json，文本与媒体推送前都会先解析它
 *     （--context > 已存文件 > 实时捕获）。token 可复用，长期未交互过期后重新捕获即可。
 *   - 结论：真正的「零前提主动推送」在 ilink bot 协议下不可行，必须先有老板的一次入站消息做 bootstrap。
 *
 * 用法:
 *   node send.js "文本消息"                                  # 主动推文本（空 token 即可）
 *   node send.js --text-file 内容.txt
 *   node send.js --image 截图.png --caption "看这张图"       # 需有效 context_token
 *   node send.js --file 报告.pdf --name "周报.pdf" --caption "请查阅"
 *   node send.js --video clip.mp4
 *   node send.js "回复" --context <token>                    # 显式指定 token（回复场景）
 *   node send.js --capture-token                            # 常驻守护：持续监听老板消息，自动捕获并保存 context_token（永不退出，建议后台运行）
 *   node send.js --verbose ...                              # 打印每步服务端响应
 *
 * 依赖: 仅 Node 内置 fetch / crypto / fs（Node 18+，推荐 managed node 22）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SETTINGS_PATH = path.join(os.homedir(), '.workbuddy', 'settings.json');
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const TOKEN_FILE = path.join(os.homedir(), '.workbuddy', 'claw-state', 'weixin', 'context-token.json');

// ── 官方对齐常量（来自 @tencent-weixin/openclaw-weixin@2.4.6）────────────
const ILINK_APP_ID = 'bot';                       // package.json ilink_appid
const PLUGIN_VERSION = '2.4.6';
function buildClientVersion(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10));
  const major = p[0] || 0, minor = p[1] || 0, patch = p[2] || 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const CLIENT_VERSION = String(buildClientVersion(PLUGIN_VERSION));
const CHANNEL_VERSION = PLUGIN_VERSION;
const BOT_AGENT = 'OpenClaw';
const TEXT_CHUNK = 4000;

const DEFAULT_TEXT =
  '🦐 ClawBot 微信主动推送测试：如果你在微信里单独收到这条 bot 消息（不是和我的对话气泡），说明主动推送已打通。';

let VERBOSE = false;
function log(...a) { if (VERBOSE) console.error('[dbg]', ...a); }

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const a = { text: null, textFile: null, image: null, file: null, video: null,
              caption: null, name: null, context: '', verbose: false, captureToken: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--text-file') a.textFile = argv[++i];
    else if (t === '--image') a.image = argv[++i];
    else if (t === '--file') a.file = argv[++i];
    else if (t === '--video') a.video = argv[++i];
    else if (t === '--caption') a.caption = argv[++i];
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--context' || t === '--ctx') a.context = argv[++i] || '';
    else if (t === '--capture-token') a.captureToken = true;
    else if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t.startsWith('--')) { /* 忽略未知 */ }
    else if (a.text === null) a.text = t;
  }
  return a;
}

// ── 工具 ─────────────────────────────────────────────────
function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}
function uuid16() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function aesEcbEncrypt(data, key) {
  return Buffer.concat([crypto.createCipheriv('aes-128-ecb', key, null).update(data), crypto.createCipheriv('aes-128-ecb', key, null).final()]);
}
function aesEcbPaddedSize(n) { return Math.ceil((n + 1) / 16) * 16; }
function md5Hex(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    Authorization: `Bearer ${token}`,
  };
}
function buildBaseInfo() { return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }; }
function chunkText(s, size) {
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// ── context_token 持久化 ─────────────────────────────────
function loadContextToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    return j.context_token || null;
  } catch { return null; }
}
function saveContextToken(tok) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ context_token: tok, saved_at: new Date().toISOString() }, null, 2));
    log('saved context_token ->', TOKEN_FILE);
  } catch (e) { log('saveContextToken failed', e.message); }
}

// ── 定位通道 ─────────────────────────────────────────────
function findWeixinClawBot(cfg) {
  const users = cfg && cfg.claw && cfg.claw.users;
  if (users) {
    for (const uid of Object.keys(users)) {
      const channels = users[uid].channels || {};
      for (const cid of Object.keys(channels)) {
        const ch = channels[cid];
        const isTarget = cid === 'weixinClawBot' ||
          (ch && ch.baseUrl && ch.baseUrl.includes('ilinkai.weixin.qq.com'));
        if (isTarget) return { name: cid, ...ch };
      }
    }
  }
  throw new Error('weixinClawBot channel not found in settings.json');
}

// ── 底层 POST ────────────────────────────────────────────
async function ilinkPost(channel, endpoint, body, timeout = 15000) {
  const base = channel.baseUrl.endsWith('/') ? channel.baseUrl : channel.baseUrl + '/';
  const url = new URL(endpoint, base).toString();
  body.base_info = buildBaseInfo();
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(channel.botToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await res.text();
  log(`POST ${endpoint} -> ${res.status}`, VERBOSE ? raw : '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw}`);
  let json = {};
  try { json = JSON.parse(raw); } catch { /* 空响应 = 成功 */ }
  if (json && json.ret && json.ret !== 0) throw new Error(`API ret=${json.ret} errmsg=${json.errmsg}`);
  if (json && json.errcode && json.errcode !== 0) throw new Error(`API errcode=${json.errcode} errmsg=${json.errmsg}`);
  return json;
}

// ── getUpdates：捕获老板消息里的 context_token ───────────
async function captureContextToken(channel, timeoutMs) {
  const base = channel.baseUrl.endsWith('/') ? channel.baseUrl : channel.baseUrl + '/';
  const url = new URL('ilink/bot/getupdates', base).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(channel.botToken),
    body: JSON.stringify({ get_updates_buf: '', base_info: buildBaseInfo() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  log('getupdates ->', res.status, VERBOSE ? raw : '');
  let json = {};
  try { json = JSON.parse(raw); } catch { /* timeout empty */ }
  const msgs = (json && json.msgs) || [];
  for (const m of msgs) {
    if (m.context_token) { saveContextToken(m.context_token); return m.context_token; }
  }
  return null;
}

// ── 发送文本（自动分片）──────────────────────────────────
async function sendText(channel, to, text, ctx) {
  const chunks = chunkText(text, TEXT_CHUNK);
  for (const c of chunks) {
    await ilinkPost(channel, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: to, client_id: uuid16(),
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text: c } }],
        context_token: ctx,
      },
    });
  }
  return chunks.length;
}

// ── 媒体上传（CDN + AES-128-ECB）────────────────────────
async function uploadMedia(channel, filePath, to, mediaType) {
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  let raw = fs.readFileSync(filePath);
  // 文本类文件补 UTF-8 BOM，避免 Windows/微信查看器按 GBK 解码导致中文乱码
  if (mediaType === 3) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.txt', '.md', '.csv', '.log', '.json', '.xml', '.yml', '.yaml', '.text'].includes(ext)) {
      if (raw.length < 3 || raw[0] !== 0xEF || raw[1] !== 0xBB || raw[2] !== 0xBF) {
        raw = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), raw]);
        log('preset UTF-8 BOM for text file');
      }
    }
  }
  const rawSize = raw.length;
  const rawMd5 = md5Hex(raw);
  const cipher = aesEcbEncrypt(raw, aesKey);
  const cipherSize = cipher.length;
  const filekey = aesKey.toString('hex');

  const resp = await ilinkPost(channel, 'ilink/bot/getuploadurl', {
    filekey, media_type: mediaType, to_user_id: to,
    rawsize: rawSize, rawfilemd5: rawMd5, filesize: cipherSize,
    no_need_thumb: true, aeskey: aesKeyHex,
  }, 20000);
  log('getuploadurl resp keys=', Object.keys(resp));

  const uploadFullUrl = (resp.upload_full_url || '').trim();
  const uploadParam = resp.upload_param;
  let cdnUrl;
  if (uploadFullUrl) cdnUrl = uploadFullUrl;
  else if (uploadParam) cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  else throw new Error('getuploadurl 未返回 upload_full_url / upload_param');

  const cdnRes = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(cipher),
    signal: AbortSignal.timeout(120000),
  });
  log('CDN upload ->', cdnRes.status);
  if (cdnRes.status >= 400 && cdnRes.status < 500) {
    const msg = cdnRes.headers.get('x-error-message') || (await cdnRes.text().catch(() => ''));
    throw new Error(`CDN 上传客户端错误 ${cdnRes.status}: ${msg}`);
  }
  if (!cdnRes.ok) {
    const msg = cdnRes.headers.get('x-error-message') || `status ${cdnRes.status}`;
    throw new Error(`CDN 上传失败 ${cdnRes.status}: ${msg}`);
  }
  const downloadParam = cdnRes.headers.get('x-encrypted-param');
  if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');

  return {
    encrypt_query_param: downloadParam,
    aes_key_b64: Buffer.from(aesKeyHex).toString('base64'),
    cipher_size: cipherSize,
    raw_size: rawSize,
  };
}

async function sendImage(channel, to, filePath, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 1);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 2, image_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, mid_size: m.cipher_size } });
  await sendMediaItems(channel, to, items, ctx, 'sendImage');
}
async function sendFile(channel, to, filePath, fileName, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 3);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 4, file_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, file_name: fileName, len: String(m.raw_size) } });
  await sendMediaItems(channel, to, items, ctx, 'sendFile');
}
async function sendVideo(channel, to, filePath, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 2);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 5, video_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, video_size: m.cipher_size } });
  await sendMediaItems(channel, to, items, ctx, 'sendVideo');
}
async function sendMediaItems(channel, to, items, ctx, label) {
  let last = '';
  for (const item of items) {
    last = uuid16();
    await ilinkPost(channel, 'ilink/bot/sendmessage', {
      msg: { from_user_id: '', to_user_id: to, client_id: last, message_type: 2, message_state: 2, item_list: [item], context_token: ctx },
    });
  }
  log(label, 'sent', items.length, 'items');
}

// ── 为媒体获取 context_token（--context > 已存 > 捕获）────
async function resolveMediaToken(channel, explicitCtx) {
  if (explicitCtx) return explicitCtx;
  const saved = loadContextToken();
  if (saved) { log('using saved context_token'); return saved; }
  console.error('[weixinclaw] 无已存 context_token，正在长轮询等待老板发消息以捕获（120s）...');
  const captured = await captureContextToken(channel, 120000);
  if (captured) { console.error('[weixinclaw] 已捕获并保存 context_token'); return captured; }
  throw new Error('未获取到 context_token：主动推送前，请先在微信给 bot 发任意一条消息（bootstrap），或在命令加 --context <token>');
}

// ── main ─────────────────────────────────────────────────
(async () => {
  const a = parseArgs(process.argv);
  VERBOSE = a.verbose;
  if (!fs.existsSync(SETTINGS_PATH)) throw new Error(`settings.json not found at ${SETTINGS_PATH}`);
  const cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  const channel = findWeixinClawBot(cfg);
  const to = channel.userId;

  // 仅捕获 token 模式（常驻守护：持续监听老板消息，自动落盘，永不退出）
  // 用法：node send.js --capture-token   （建议以后台常驻方式运行）
  if (a.captureToken) {
    console.error('[weixinclaw] 常驻捕获模式：持续监听老板微信消息，自动保存 context_token（Ctrl+C 退出）');
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        console.error(`[weixinclaw] 第 ${attempt} 次长轮询...`);
        const tok = await captureContextToken(channel, 60000);
        if (tok) console.error(`[weixinclaw] 捕获成功并保存（前20位: ${tok.slice(0, 20)}...），继续监听以保持 token 新鲜`);
      } catch (e) {
        console.error(`[weixinclaw] 轮询出错，${e.message} — 2s 后重试`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return;
  }

  console.log(`[weixinclaw] channel=${channel.name} to=${to} mode=${a.context ? 'reply' : 'proactive'} appid=${ILINK_APP_ID} cver=${CLIENT_VERSION} chver=${CHANNEL_VERSION}`);

  // 所有模式都需有效 context_token（文本/媒体均强制，实测空 token => ret:-2）
  const ctx = a.context || await resolveMediaToken(channel, '');

  let n = 0;
  if (a.image) {
    await sendImage(channel, to, a.image, a.caption || '', ctx);
    console.log('[weixinclaw] 图片已推送'); n++;
  } else if (a.video) {
    await sendVideo(channel, to, a.video, a.caption || '', ctx);
    console.log('[weixinclaw] 视频已推送'); n++;
  } else if (a.file) {
    await sendFile(channel, to, a.file, a.name || path.basename(a.file), a.caption || '', ctx);
    console.log('[weixinclaw] 文件已推送'); n++;
  } else if (a.textFile) {
    const t = fs.readFileSync(a.textFile, 'utf-8').replace(/\r\n/g, '\n').trim();
    n += await sendText(channel, to, t, ctx);
  } else if (a.text != null) {
    n += await sendText(channel, to, a.text, ctx);
  } else {
    n += await sendText(channel, to, DEFAULT_TEXT, ctx);
  }

  console.log(`[weixinclaw] OK — 共推送 ${n} 条消息，请老板在微信确认是否收到 ClawBot 推送。`);
})().catch((e) => {
  console.error('[weixinclaw] FAILED:', e.message);
  process.exit(1);
});
