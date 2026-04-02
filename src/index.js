/**
 * B站自动化工具 - 主入口
 * 当前主用途：弹幕宠物挂机修炼；兼容本地辅助宠物签到
 */

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');

// ==============================
// 配置读取
// ==============================
const COOKIE = process.env.BILIBILI_COOKIE || '';
const UID = process.env.BILIBILI_UID || '';
const HANGUP_ROOM_ID = process.env.HANGUP_ROOM_ID || '5456135';  // 弹幕宠物所在直播间
const HANGUP_DURATION = parseInt(process.env.HANGUP_DURATION || '3600', 10);
const PET_NAME = process.env.PET_NAME || '我的弹幕宠物';
const TASK = process.env.TASK || 'hangup'; // hangup | pet | all

// 随机挂机直播间列表（用于B站经验心跳，与弹幕宠物直播间不同）
// 可通过环境变量 RANDOM_ROOMS 覆盖，格式：逗号分隔的房间号，如 "732,6,1,76"
const RANDOM_ROOMS_RAW = process.env.RANDOM_ROOMS || '732,6,1,76,488,21452505';
const RANDOM_ROOMS = RANDOM_ROOMS_RAW.split(',').map(s => s.trim()).filter(Boolean);

// 自动发现弹幕宠物直播间的关键词与扫描深度
const PET_ROOM_KEYWORDS_RAW = process.env.PET_ROOM_KEYWORDS || '弹幕宠物,修仙,突破,签到,宠物,修炼';
const PET_ROOM_KEYWORDS = PET_ROOM_KEYWORDS_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PET_DISCOVERY_PAGES = Math.max(1, parseInt(process.env.PET_DISCOVERY_PAGES || '2', 10));
const PET_DISCOVERY_LIMIT = Math.max(5, parseInt(process.env.PET_DISCOVERY_LIMIT || '12', 10));
const PET_PRIORITY_ROOMS_RAW = process.env.PET_PRIORITY_ROOMS || '1788399444';
const PET_PRIORITY_ROOMS = PET_PRIORITY_ROOMS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const PET_PRIORITY_ROOM_SET = new Set(PET_PRIORITY_ROOMS);


// 签到弹幕指令
const SIGNIN_DANMU = '签到';

// 邮件通知配置（通过环境变量注入）
const MAIL_USER = process.env.QQ_MAIL_USER || '';       // QQ邮箱地址
const MAIL_PASS = process.env.QQ_MAIL_PASS || '';       // QQ邮箱授权码

// 从 Cookie 中提取 bili_jct 作为 csrf
function extractCsrf(cookie) {
  const m = cookie.match(/bili_jct=([^;]+)/);
  return m ? m[1].trim() : '';
}

// 从 Cookie 中提取 uid（DedeUserID）
function extractUid(cookie) {
  const m = cookie.match(/DedeUserID=([^;]+)/);
  return m ? m[1].trim() : '';
}

const CSRF = extractCsrf(COOKIE);
const AUTO_UID = UID || extractUid(COOKIE);

let RUN_DETAILS = {};

function truncateText(value, maxLen = 200) {
  const text = value == null ? '' : String(value);
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

function getPetPriorityMeta(roomId) {
  const normalizedRoomId = String(roomId || '').trim();
  const priorityIndex = PET_PRIORITY_ROOMS.indexOf(normalizedRoomId);
  return {
    priorityPinned: priorityIndex !== -1,
    priorityIndex,
    priorityReason: priorityIndex === -1
      ? ''
      : `历史确认打出过 +19（PET_PRIORITY_ROOMS 第 ${priorityIndex + 1} 位）`
  };
}

function formatPetCandidateForLog(candidate) {
  const tags = [];
  if (candidate.priorityPinned) tags.push('历史+19');
  if (candidate.keywordScore > 0) tags.push(`关键词${candidate.keywordScore}`);
  if (candidate.online > 0) tags.push(`在线${candidate.online}`);
  return `${candidate.roomId}${tags.length ? `[${tags.join(' / ')}]` : ''}`;
}

function simplifyApiResponse(res) {

  if (!res || typeof res !== 'object') return res;
  return {
    code: res.code,
    message: truncateText(res.message || res.msg || res.raw || ''),
    data: res.data && typeof res.data === 'object'
      ? truncateText(JSON.stringify(res.data), 300)
      : truncateText(res.data, 300)
  };
}

function setRunDetail(key, value) {
  RUN_DETAILS[key] = value;
  return value;
}


// ==============================
// HTTP 请求工具
// ==============================
function request(options, postData, extraOptions = {}) {
  const { silent = false } = extraOptions;

  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!silent) {
          console.log(`   [HTTP] ${options.method} ${options.hostname}${options.path} → ${res.statusCode}`);
          console.log(`   [RAW] ${data.substring(0, 300)}`);
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          if (!silent) {
            console.warn(`   [WARN] 响应不是JSON: ${data.substring(0, 100)}`);
          }
          resolve({ raw: data, code: -999 });
        }
      });
    });
    req.on('error', (err) => {
      if (!silent) {
        console.error(`   [ERR] 请求失败: ${err.message}`);
      }
      reject(err);
    });
    req.setTimeout(15000, () => { req.destroy(new Error('请求超时')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ==============================
// 发送QQ邮件通知
// ==============================
function sendMail(subject, body) {
  return new Promise((resolve) => {
    if (!MAIL_USER || !MAIL_PASS) {
      console.log('   ℹ️  未配置邮件通知（QQ_MAIL_USER / QQ_MAIL_PASS）');
      return resolve(false);
    }

    const from = MAIL_USER;
    const to   = MAIL_USER; // 发给自己
    const boundary = '----=_NodeMailer_' + Date.now();

    // 构造邮件内容（Base64编码支持中文）
    const encSubject = '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=';
    const msgLines = [
      `From: B站自动化 <${from}>`,
      `To: ${to}`,
      `Subject: ${encSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: text/plain; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64')
    ].join('\r\n');

    // QQ邮箱 SMTP over SSL，端口 465
    const socket = tls.connect({ host: 'smtp.qq.com', port: 465 }, () => {});
    let step = 0;
    let buf = '';

    const send = (cmd) => socket.write(cmd + '\r\n');

    socket.setTimeout(15000, () => {
      console.warn('   ⚠️  邮件发送超时');
      socket.destroy();
      resolve(false);
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      if (!buf.endsWith('\n')) return;
      const line = buf.trim();
      buf = '';

      if (step === 0 && line.startsWith('220')) {
        send(`EHLO smtp.qq.com`); step = 1;
      } else if (step === 1 && line.includes('250')) {
        const auth = Buffer.from('\0' + from + '\0' + MAIL_PASS).toString('base64');
        send(`AUTH PLAIN ${auth}`); step = 2;
      } else if (step === 2 && line.startsWith('235')) {
        send(`MAIL FROM:<${from}>`); step = 3;
      } else if (step === 3 && line.startsWith('250')) {
        send(`RCPT TO:<${to}>`); step = 4;
      } else if (step === 4 && line.startsWith('250')) {
        send('DATA'); step = 5;
      } else if (step === 5 && line.startsWith('354')) {
        socket.write(msgLines + '\r\n.\r\n'); step = 6;
      } else if (step === 6 && line.startsWith('250')) {
        console.log('   ✅ 邮件发送成功');
        send('QUIT'); step = 7;
        socket.end();
        resolve(true);
      } else if (line.startsWith('5') || line.startsWith('4')) {
        console.warn(`   ⚠️  SMTP错误: ${line}`);
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', (e) => {
      console.warn(`   ⚠️  邮件发送失败: ${e.message}`);
      resolve(false);
    });
  });
}

function buildHeaders(extraHeaders) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': COOKIE,
    'Referer': 'https://www.bilibili.com',
    'Origin': 'https://www.bilibili.com',
    ...extraHeaders
  };
}

// GET 请求
function apiGet(path) {
  return request({
    hostname: 'api.bilibili.com',
    path: path,
    method: 'GET',
    headers: buildHeaders()
  });
}

// POST 请求（application/x-www-form-urlencoded）
function apiPost(path, body) {
  const postData = body;
  return request({
    hostname: 'api.bilibili.com',
    path: path,
    method: 'POST',
    headers: buildHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    })
  }, postData);
}

// POST 请求到 live.bilibili.com
function livePost(path, body) {
  const postData = body;
  return request({
    hostname: 'live-trace.bilibili.com',
    path: path,
    method: 'POST',
    headers: {
      ...buildHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
}

// ==============================
// 弹幕宠物直播间探测
// 流程：直播间页面 → game_id → panel_url(token) → 判断是否开启弹幕宠物
// ==============================
function scorePetRoomCandidate(candidate) {
  const text = [
    candidate.title || '',
    candidate.anchorName || '',
    candidate.areaName || '',
    candidate.parentAreaName || '',
    candidate.tags || ''
  ].join(' ').toLowerCase();

  return PET_ROOM_KEYWORDS.reduce((score, keyword) => {
    return text.includes(keyword) ? score + 1 : score;
  }, 0);
}

function normalizeLiveRoomCandidate(raw, source) {
  const roomId = raw?.roomid || raw?.room_id || raw?.id;
  if (!roomId) return null;

  const candidate = {
    roomId: String(roomId),
    title: raw?.title || raw?.roomtitle || '',
    anchorName: raw?.uname || raw?.anchor_name || raw?.name || '',
    areaName: raw?.area_name || raw?.area_v2_name || '',
    parentAreaName: raw?.parent_area_name || raw?.area_v2_parent_name || '',
    tags: raw?.tags || raw?.tag_name || '',
    online: Number(raw?.online || raw?.online_num || 0),
    isLive: Number(raw?.live_status || raw?.liveStatus || 0) === 1,
    source,
  };

  candidate.keywordScore = scorePetRoomCandidate(candidate);
  return candidate;
}

async function fetchLiveRoomCandidates() {
  const candidates = [];
  const seen = new Set();

  for (let page = 1; page <= PET_DISCOVERY_PAGES; page++) {
    const paths = [
      `/xlive/web-interface/v1/second/getList?platform=web&parent_area_id=0&area_id=0&sort_type=&page=${page}`,
      `/xlive/web-interface/v1/index/getList?platform=web&page=${page}&page_size=30`
    ];

    for (const path of paths) {
      try {
        const res = await request({
          hostname: 'api.live.bilibili.com',
          path,
          method: 'GET',
          headers: buildHeaders({
            'Referer': 'https://live.bilibili.com',
            'Origin': 'https://live.bilibili.com',
          })
        }, null, { silent: true });

        const list = Array.isArray(res?.data?.list)
          ? res.data.list
          : (Array.isArray(res?.data?.rooms) ? res.data.rooms : []);

        for (const raw of list) {
          const candidate = normalizeLiveRoomCandidate(raw, '直播列表扫描');
          if (!candidate || seen.has(candidate.roomId)) continue;
          seen.add(candidate.roomId);
          candidates.push(candidate);
        }
      } catch (e) {
        // 某个列表接口失败时忽略，继续扫描其他接口
      }
    }
  }

  return candidates.sort((a, b) => {
    return (b.keywordScore - a.keywordScore)
      || (Number(b.isLive) - Number(a.isLive))
      || (b.online - a.online);
  });
}

async function fetchPetPanelUrl(roomId, gameId, options = {}) {
  const silent = options.silent === true;
  const warn = (...args) => { if (!silent) console.warn(...args); };

  try {
    const panelRes = await request({
      hostname: 'api.live.bilibili.com',
      path: `/xlive/open-platform/v1/game/getAppCustomPanel?game_id=${encodeURIComponent(gameId)}`,
      method: 'GET',
      headers: buildHeaders({
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com',
      })
    }, null, { silent });

    const panelUrl = panelRes?.data?.panel_url || panelRes?.data?.list?.[0]?.panel_url;
    if (!panelUrl || !panelUrl.includes('heikeyun')) {
      warn(`   ⚠️  未检测到弹幕宠物 panel_url，game_id=${gameId}，返回: ${JSON.stringify(panelRes?.data || {})}`);
      return null;
    }

    return panelUrl;
  } catch (e) {
    warn(`   ⚠️  获取弹幕宠物 panel_url 异常: ${e.message}`);
    return null;
  }
}

function summarizeRoomStatus(status) {
  if (!status) return null;
  return {
    roomId: String(status.roomId || ''),
    shortRoomId: String(status.shortRoomId || ''),
    isLive: status.isLive === true,
    liveStatus: typeof status.liveStatus === 'number' ? status.liveStatus : null,
    title: status.title || '',
    anchorName: status.anchorName || '',
    anchorUid: String(status.anchorUid || ''),
    parentAreaId: Number(status.parentAreaId || 0),
    areaId: Number(status.areaId || 0),
    online: Number(status.online || 0)
  };
}

function summarizePetPanelInspection(inspection) {
  if (!inspection) return null;
  return {
    detected: inspection.ok === true,
    detection: inspection.detection || '',
    gameId: inspection.gameId || '',
    gameName: inspection.gameName || '',
    hasPanelUrl: inspection.hasPanelUrl === true,
    panelUrl: inspection.panelUrl ? truncateText(inspection.panelUrl, 200) : '',
    reason: inspection.reason || ''
  };
}

async function inspectPetPanel(roomId, options = {}) {
  const silent = options.silent === true;
  const log = (...args) => { if (!silent) console.log(...args); };
  const warn = (...args) => { if (!silent) console.warn(...args); };
  const result = {
    roomId: String(roomId),
    ok: false,
    detection: '',
    gameId: '',
    gameName: '',
    panelUrl: '',
    hasPanelUrl: false,
    reason: ''
  };

  try {
    const livePage = await request({
      hostname: 'live.bilibili.com',
      path: `/${roomId}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': COOKIE,
        'Referer': `https://live.bilibili.com/${roomId}`
      }
    }, null, { silent });

    const liveHtml = livePage?.raw || '';
    let nonPetInteractiveGameName = '';

    const interactiveTagMatch = liveHtml.match(/"interactive_game_tag":\{"action":\d+,"game_id":"([^"]+)","game_name":"([^"]+)"/);
    if (interactiveTagMatch) {
      const gameId = interactiveTagMatch[1];
      const gameName = interactiveTagMatch[2];
      result.gameId = gameId;
      result.gameName = gameName;
      result.detection = 'interactive_game_tag';

      if (gameName.includes('弹幕宠物')) {
        const panelUrl = await fetchPetPanelUrl(roomId, gameId, { silent });
        result.panelUrl = panelUrl || '';
        result.hasPanelUrl = !!panelUrl;
        result.detection = panelUrl ? 'interactive_game_tag+panel_url' : 'interactive_game_tag';
        result.ok = !!panelUrl;
        result.reason = panelUrl ? '' : '检测到弹幕宠物互动标签，但未拿到可用 panel_url';
        log(`   检测到互动玩法标签: ${gameName} (${gameId})${panelUrl ? '，并已拿到 panel_url' : ''}`);
        return result;
      }

      nonPetInteractiveGameName = gameName;
    }

    const gameIdMatch = liveHtml.match(/"game_id"\s*:\s*"?(\d+)"?/);
    if (!gameIdMatch) {
      result.reason = nonPetInteractiveGameName
        ? `检测到互动玩法 ${nonPetInteractiveGameName}，但不是弹幕宠物`
        : '未找到可用的 game_id / interactive_game_tag，可能直播间未开播或未开启弹幕宠物';
      warn(`   ⚠️  ${result.reason}`);
      return result;
    }

    const gameId = gameIdMatch[1];
    result.gameId = gameId;
    log(`   game_id: ${gameId}`);

    const panelUrl = await fetchPetPanelUrl(roomId, gameId, { silent });
    result.panelUrl = panelUrl || '';
    result.hasPanelUrl = !!panelUrl;
    result.detection = panelUrl ? 'panel_url' : 'game_id';
    result.ok = !!panelUrl;
    result.reason = panelUrl ? '' : '拿到 game_id 但未检测到可用 panel_url';

    if (panelUrl) {
      log('   panel_url 已获取，已检测到弹幕宠物');
    }
    return result;
  } catch (e) {
    result.reason = `检测弹幕宠物异常: ${e.message}`;
    warn(`   ⚠️  ${result.reason}`);
    return result;
  }
}

async function getPetPanelMeta(roomId, options = {}) {
  const inspection = await inspectPetPanel(roomId, options);
  if (!inspection.ok) return null;
  return {
    roomId: String(roomId),
    gameId: inspection.gameId,
    gameName: inspection.gameName,
    panelUrl: inspection.panelUrl,
    detection: inspection.detection
  };
}

async function findActivePetRoom(excludeRoomIds = [], options = {}) {
  const excluded = new Set(excludeRoomIds.map(id => String(id)));
  const collected = new Map();
  const diagnosticTarget = options.diagnosticTarget && typeof options.diagnosticTarget === 'object'
    ? options.diagnosticTarget
    : null;
  const traceLimit = Math.max(1, Number(options.traceLimit || 6));
  const tracedCandidates = [];

  if (diagnosticTarget) {
    diagnosticTarget.excludedRoomIds = Array.from(excluded);
    diagnosticTarget.discoveredCandidateCount = 0;
    diagnosticTarget.scannedCandidateCount = 0;
    diagnosticTarget.selectedRoomId = '';
    diagnosticTarget.selectedReason = '';
    diagnosticTarget.topCandidates = [];
  }

  const pushTrace = (trace) => {
    if (tracedCandidates.length < traceLimit) {
      tracedCandidates.push(trace);
    }
    if (diagnosticTarget) {
      diagnosticTarget.topCandidates = tracedCandidates;
    }
  };

  const addCandidate = (roomId, source, extra = {}) => {
    const id = String(roomId || '').trim();
    if (!id || excluded.has(id) || collected.has(id)) return;
    collected.set(id, {
      roomId: id,
      title: extra.title || '',
      anchorName: extra.anchorName || '',
      online: Number(extra.online || 0),
      isLive: extra.isLive,
      keywordScore: Number(extra.keywordScore || 0),
      source,
      ...getPetPriorityMeta(id)
    });
  };

  for (const roomId of RANDOM_ROOMS) {
    addCandidate(roomId, '备用房间列表');
  }

  const discovered = await fetchLiveRoomCandidates();
  if (diagnosticTarget) {
    diagnosticTarget.discoveredCandidateCount = discovered.length;
  }

  for (const candidate of discovered) {
    if (candidate.keywordScore > 0 || collected.size < PET_DISCOVERY_LIMIT) {
      addCandidate(candidate.roomId, candidate.source, candidate);
    }
    if (collected.size >= PET_DISCOVERY_LIMIT) break;
  }

  const orderedCandidates = Array.from(collected.values()).sort((a, b) => {
    return Number(b.priorityPinned) - Number(a.priorityPinned)
      || (a.priorityIndex - b.priorityIndex)
      || (b.keywordScore - a.keywordScore)
      || (b.online - a.online);
  });

  if (diagnosticTarget) {
    diagnosticTarget.scannedCandidateCount = orderedCandidates.length;
  }

  if (orderedCandidates.length > 0) {
    console.log(`   候选排序（优先历史 +19 房间）: ${orderedCandidates.slice(0, 6).map(formatPetCandidateForLog).join(' → ')}`);
  }

  for (const candidate of orderedCandidates) {
    const trace = {
      roomId: candidate.roomId,
      title: candidate.title || '',
      anchorName: candidate.anchorName || '',
      source: candidate.source || '',
      online: Number(candidate.online || 0),
      keywordScore: Number(candidate.keywordScore || 0),
      priorityPinned: !!candidate.priorityPinned,
      priorityIndex: typeof candidate.priorityIndex === 'number' ? candidate.priorityIndex : -1,
      priorityReason: candidate.priorityReason || '',
      liveCheck: null,
      petPanel: null,
      selected: false,
      skipReason: ''
    };

    const status = candidate.isLive === true
      ? candidate
      : await getRoomLiveStatus(candidate.roomId);

    trace.liveCheck = summarizeRoomStatus(status);
    if (!status) {
      trace.skipReason = '获取直播间状态失败';
      pushTrace(trace);
      continue;
    }

    if (!status.isLive) {
      trace.skipReason = '直播间未开播';
      pushTrace(trace);
      continue;
    }

    const petInspection = await inspectPetPanel(candidate.roomId, { silent: true });
    trace.petPanel = summarizePetPanelInspection(petInspection);
    if (petInspection.ok) {
      trace.selected = true;
      pushTrace(trace);
      if (diagnosticTarget) {
        diagnosticTarget.selectedRoomId = candidate.roomId;
        diagnosticTarget.selectedReason = '已找到开播且已开启弹幕宠物的候选房间';
      }
      if (candidate.priorityPinned) {
        console.log(`   🎯 命中历史 +19 优先房间 ${candidate.roomId}`);
      }
      return {
        roomId: candidate.roomId,
        title: status.title || candidate.title || '',
        anchorName: status.anchorName || candidate.anchorName || '',
        online: status.online || candidate.online || 0,
        source: candidate.source,
        petDetection: petInspection.detection || '',
        petGameId: petInspection.gameId || '',
        petGameName: petInspection.gameName || '',
        priorityPinned: candidate.priorityPinned,
        priorityIndex: candidate.priorityIndex,
        priorityReason: candidate.priorityReason
      };
    }

    trace.skipReason = petInspection.reason || '未检测到弹幕宠物';
    pushTrace(trace);
  }

  if (diagnosticTarget && !diagnosticTarget.selectedReason) {
    diagnosticTarget.selectedReason = '扫描结束仍未找到开播且已开启弹幕宠物的候选房间';
  }

  return null;
}

async function resolvePetRoom(actionLabel, options = {}) {
  console.log(`   🔎 正在为${actionLabel}定位已开启弹幕宠物的直播间...`);
  const debugTarget = options.debugTarget && typeof options.debugTarget === 'object'
    ? options.debugTarget
    : null;

  if (debugTarget) {
    debugTarget.configuredRoom = null;
    debugTarget.scan = null;
  }

  const preferredStatus = await getRoomLiveStatus(HANGUP_ROOM_ID);
  const configuredDiagnostic = {
    roomId: String(HANGUP_ROOM_ID),
    liveCheck: summarizeRoomStatus(preferredStatus),
    petPanel: null,
    selected: false,
    decision: '',
    skipReason: ''
  };

  if (debugTarget) {
    debugTarget.configuredRoom = configuredDiagnostic;
  }

  if (preferredStatus) {
    console.log(`   配置直播间状态: ${preferredStatus.isLive ? '✅ 直播中' : '⭕ 未开播'} (${preferredStatus.title || ''})`);
  } else {
    configuredDiagnostic.skipReason = '获取配置直播间状态失败';
  }

  if (preferredStatus && preferredStatus.isLive) {
    const preferredInspection = await inspectPetPanel(HANGUP_ROOM_ID, { silent: true });
    configuredDiagnostic.petPanel = summarizePetPanelInspection(preferredInspection);
    if (preferredInspection.ok) {
      const preferredPriority = getPetPriorityMeta(HANGUP_ROOM_ID);
      configuredDiagnostic.selected = true;
      configuredDiagnostic.decision = 'use-configured-room';
      console.log(`   ✅ 配置直播间 ${HANGUP_ROOM_ID} 已开启弹幕宠物，直接使用`);
      if (preferredPriority.priorityPinned) {
        console.log(`   📌 配置直播间同时也在历史 +19 优先列表中（第 ${preferredPriority.priorityIndex + 1} 位）`);
      }
      return {
        roomId: String(HANGUP_ROOM_ID),
        title: preferredStatus.title || '',
        anchorName: preferredStatus.anchorName || '',
        online: preferredStatus.online || 0,
        switched: false,
        switchedFrom: null,
        source: '配置直播间',
        petDetection: preferredInspection.detection || '',
        petGameId: preferredInspection.gameId || '',
        petGameName: preferredInspection.gameName || '',
        priorityPinned: preferredPriority.priorityPinned,
        priorityIndex: preferredPriority.priorityIndex,
        priorityReason: preferredPriority.priorityReason
      };

    }

    configuredDiagnostic.decision = 'scan-other-rooms';
    configuredDiagnostic.skipReason = preferredInspection.reason || '配置直播间正在直播，但未检测到弹幕宠物';
    console.log(`   ⚠️  配置直播间 ${HANGUP_ROOM_ID} 正在直播，但未检测到弹幕宠物，开始自动切换...`);
  } else {
    configuredDiagnostic.decision = 'scan-other-rooms';
    configuredDiagnostic.skipReason = configuredDiagnostic.skipReason || '配置直播间未开播';
    console.log(`   ⚠️  配置直播间 ${HANGUP_ROOM_ID} 当前不可用，开始扫描其他直播间...`);
  }

  const scanDiagnostic = {};
  if (debugTarget) {
    debugTarget.scan = scanDiagnostic;
  }

  const activePetRoom = await findActivePetRoom([HANGUP_ROOM_ID], {
    diagnosticTarget: scanDiagnostic,
    traceLimit: 6
  });
  if (!activePetRoom) {
    console.log('   ❌ 未找到正在开播且已开启弹幕宠物的直播间');
    return null;
  }

  console.log(`   ✅ 已切换到弹幕宠物直播间 ${activePetRoom.roomId}（${activePetRoom.title || activePetRoom.anchorName || '未知直播间'}）`);
  return {
    ...activePetRoom,
    switched: true,
    switchedFrom: String(HANGUP_ROOM_ID),
  };
}


// ==============================
// 查询宠物修炼经验值
// 流程：直播间页面 → game_id → panel_url(token) → 解析经验值
// ==============================
async function getPetEnergy(roomId, options = {}) {
  const silent = options.silent === true;
  const log = (...args) => { if (!silent) console.log(...args); };
  const warn = (...args) => { if (!silent) console.warn(...args); };
  const debugTarget = options.debugTarget && typeof options.debugTarget === 'object' ? options.debugTarget : null;
  const setDebug = (patch) => {
    if (debugTarget) Object.assign(debugTarget, patch);
  };

  try {
    const panelMeta = await getPetPanelMeta(roomId, { silent });
    setDebug({
      panelMeta: panelMeta ? {
        roomId: panelMeta.roomId,
        gameId: panelMeta.gameId,
        gameName: panelMeta.gameName,
        detection: panelMeta.detection,
        hasPanelUrl: !!panelMeta.panelUrl,
        panelUrl: panelMeta.panelUrl ? truncateText(panelMeta.panelUrl, 200) : null
      } : null
    });

    if (!panelMeta) {
      setDebug({ reason: 'panel_meta_not_found' });
      return null;
    }

    if (!panelMeta.panelUrl) {
      setDebug({ reason: 'panel_url_missing' });
      warn(`   ⚠️  已识别到弹幕宠物（${panelMeta.gameName || panelMeta.detection || '未知来源'}），但暂时拿不到可解析的经验面板 URL`);
      return null;
    }

    const urlObj = new URL(panelMeta.panelUrl);
    setDebug({ panelHost: urlObj.hostname, panelPath: truncateText(urlObj.pathname + urlObj.search, 200) });

    const fetchPanelHtml = async (targetUrl) => {
      const target = new URL(targetUrl);
      const panelPage = await request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://live.bilibili.com/${roomId}`
        }
      }, null, { silent });
      return panelPage?.raw || '';
    };

    let panelHtml = await fetchPanelHtml(panelMeta.panelUrl);
    let redirectMatch = panelHtml.match(/Object moved to <a href="([^"]+)"/i);
    let redirectCount = 0;
    while (redirectMatch && redirectCount < 3) {
      redirectCount += 1;
      const redirectUrl = new URL(redirectMatch[1], panelMeta.panelUrl).toString();
      setDebug({
        redirectCount,
        redirectUrl: truncateText(redirectUrl, 220)
      });
      panelHtml = await fetchPanelHtml(redirectUrl);
      redirectMatch = panelHtml.match(/Object moved to <a href="([^"]+)"/i);
    }

    setDebug({
      panelHtmlLength: panelHtml.length,
      hasLblUserEnergy2: panelHtml.includes('lblUserEnergy2'),
      hasLblUserEnergyDown: panelHtml.includes('lblUserEnergyDown'),
      panelHtmlSnippet: truncateText(panelHtml.replace(/\s+/g, ' '), 400)
    });

    const curMatch  = panelHtml.match(/id="lblUserEnergy2"[^>]*>([^<]+)</);

    const fullMatch = panelHtml.match(/id="lblUserEnergyDown"[^>]*>([^<]+)</);
    const levelMatch = panelHtml.match(/id="lblUserLevel"[^>]*>([^<]+)</);
    const levelNameMatch = panelHtml.match(/id="lblUserLevelName"[^>]*>([^<]+)</);

    if (!curMatch || !fullMatch) {
      setDebug({
        reason: 'energy_regex_miss',
        curMatchFound: !!curMatch,
        fullMatchFound: !!fullMatch
      });
      warn('   ⚠️  无法从面板页面解析经验值（可能面板格式变更）');
      return null;
    }

    const current = parseInt(curMatch[1].trim(), 10);
    const full    = parseInt(fullMatch[1].trim(), 10);
    const level   = levelMatch ? levelMatch[1].trim() : '?';
    const levelName = levelNameMatch ? levelNameMatch[1].trim() : '?';

    setDebug({ reason: 'ok', current, full, level, levelName });
    log(`   🐾 宠物状态: Lv.${level} ${levelName}`);
    log(`   ⚡ 修炼经验: ${current} / ${full} (${Math.floor(current / full * 100)}%)`);

    return {
      current,
      full,
      isFull: current >= full,
      level,
      levelName,
      roomId: String(roomId),
      panelUrl: panelMeta.panelUrl,
    };
  } catch (e) {
    setDebug({ reason: 'exception', error: e.message });
    warn(`   ⚠️  查询宠物经验异常: ${e.message}`);
    return null;
  }
}

function extractHtmlInputValue(html, inputId) {
  const match = String(html || '').match(new RegExp(`id="${inputId}"[^>]*value="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function simplifyPetPanelCommandResponse(res) {
  if (!res || typeof res !== 'object') {
    return {
      code: -1,
      message: truncateText(res, 200)
    };
  }
  return {
    code: typeof res.Code !== 'undefined' ? res.Code : (typeof res.code !== 'undefined' ? res.code : -1),
    message: truncateText(res.Msg || res.message || res.msg || res.raw || '', 200)
  };
}

function simplifyPetEnergy(energy) {
  if (!energy) return null;
  return {
    roomId: energy.roomId,
    current: energy.current,
    full: energy.full,
    isFull: energy.isFull,
    level: energy.level,
    levelName: energy.levelName
  };
}

function calculateEnergyDelta(fromEnergy, toEnergy) {
  if (!fromEnergy || !toEnergy) return null;

  const fromCurrent = Number(fromEnergy.current);
  const toCurrent = Number(toEnergy.current);
  if (!Number.isFinite(fromCurrent) || !Number.isFinite(toCurrent)) {
    return null;
  }

  return toCurrent - fromCurrent;
}

function isIdleLikeGain(delta) {
  return Number.isFinite(delta) && delta >= 14 && delta % 14 === 0;
}

function evaluateCultivationGain(beforeEnergy, afterEnergy, options = {}) {
  const round = Math.max(1, Number(options.round || 1));
  const maxRounds = Math.max(round, Number(options.maxRounds || 1));
  const waitSeconds = Math.max(1, Math.round(Number(options.waitMs || 12000) / 1000));
  const totalWaitSeconds = waitSeconds * round;
  const previousEnergy = options.previousEnergy || beforeEnergy;
  const windowDelta = calculateEnergyDelta(previousEnergy, afterEnergy);

  if (!beforeEnergy || !afterEnergy) {
    return {
      verified: false,
      delta: null,
      windowDelta,
      round,
      maxRounds,
      waitSeconds,
      totalWaitSeconds,
      expectedActiveGain: 19,
      expectedIdleGain: 14,
      idleLike: false,
      delayedLike: false,
      needsAnotherCheck: round < maxRounds,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查未拿到完整经验，继续做下一次复查排除显示滞后`
        : `两次 ${waitSeconds} 秒复查后仍未拿到完整经验，无法确认修炼是否真实生效`
    };
  }

  const delta = calculateEnergyDelta(beforeEnergy, afterEnergy);
  if (!Number.isFinite(delta)) {
    return {
      verified: false,
      delta: null,
      windowDelta,
      round,
      maxRounds,
      waitSeconds,
      totalWaitSeconds,
      expectedActiveGain: 19,
      expectedIdleGain: 14,
      idleLike: false,
      delayedLike: false,
      needsAnotherCheck: round < maxRounds,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查经验格式异常，继续做下一次复查排除显示滞后`
        : `两次 ${waitSeconds} 秒复查后经验格式仍异常，无法确认修炼是否真实生效`
    };
  }

  if (delta >= 19 && !isIdleLikeGain(delta)) {
    return {
      verified: true,
      delta,
      windowDelta,
      round,
      maxRounds,
      waitSeconds,
      totalWaitSeconds,
      expectedActiveGain: 19,
      expectedIdleGain: 14,
      idleLike: false,
      delayedLike: false,
      needsAnotherCheck: false,
      reason: `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，且不是 +14 的倍数，可确认修炼加成已生效`
    };
  }

  if (delta >= 19 && isIdleLikeGain(delta)) {
    return {
      verified: false,
      delta,
      windowDelta,
      round,
      maxRounds,
      waitSeconds,
      totalWaitSeconds,
      expectedActiveGain: 19,
      expectedIdleGain: 14,
      idleLike: true,
      delayedLike: true,
      needsAnotherCheck: round < maxRounds,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验 +${delta}，但属于 +14 的倍数，更像经验显示滞后；继续做下一次复查`
        : `两次 ${waitSeconds} 秒复查后累计经验 +${delta}，仍属于 +14 的倍数，更像滞后显示的基础在线收益，未确认修炼加成生效`
    };
  }

  if (delta >= 14) {
    return {
      verified: false,
      delta,
      windowDelta,
      round,
      maxRounds,
      waitSeconds,
      totalWaitSeconds,
      expectedActiveGain: 19,
      expectedIdleGain: 14,
      idleLike: true,
      delayedLike: false,
      needsAnotherCheck: round < maxRounds,
      reason: round < maxRounds
        ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验仅 +${delta}，更像基础在线收益；继续做下一次复查`
        : `两次 ${waitSeconds} 秒复查后累计经验仅 +${delta}，仍未达到修炼成功所需的有效增量`
    };
  }

  return {
    verified: false,
    delta,
    windowDelta,
    round,
    maxRounds,
    waitSeconds,
    totalWaitSeconds,
    expectedActiveGain: 19,
    expectedIdleGain: 14,
    idleLike: false,
    delayedLike: false,
    needsAnotherCheck: round < maxRounds,
    reason: round < maxRounds
      ? `第 ${round} 次 ${waitSeconds} 秒复查后累计经验仅 +${delta}，继续做下一次复查确认是否存在显示滞后`
      : `两次 ${waitSeconds} 秒复查后累计经验仅 +${delta}，未达到修炼成功应有的有效增量`
  };
}

async function triggerCultivationAttempt(roomId, roomInfo, triggerConfig, options = {}) {
  const energyDebug = options.energyDebug && typeof options.energyDebug === 'object' ? options.energyDebug : null;
  const waitMs = Number(options.waitMs || 12000);
  const maxVerifyRounds = Math.max(1, Number(options.maxVerifyRounds || 2));
  const beforeEnergyRaw = await getPetEnergy(roomId, { silent: true });
  const detail = {
    method: triggerConfig.method,
    label: triggerConfig.label,
    danmuText: triggerConfig.danmuText || '',
    accepted: false,
    active: false,
    available: true,
    response: null,
    reason: '',
    panelMeta: null,
    panelCommandMeta: null,
    energyBefore: simplifyPetEnergy(beforeEnergyRaw),
    heartbeatAfter: null,
    energyAfter: null,
    gainCheck: null,
    verificationChecks: []
  };

  if (detail.energyBefore) {
    console.log(`   ${triggerConfig.label}前经验: ${detail.energyBefore.current}/${detail.energyBefore.full} | Lv.${detail.energyBefore.level} ${detail.energyBefore.levelName}`);
  } else {
    console.warn(`   ⚠️  ${triggerConfig.label}前未能读取经验，后续无法准确做 12 秒增量校验`);
  }

  let rawResult = null;
  try {
    rawResult = await triggerConfig.execute();
  } catch (e) {
    rawResult = { code: -1, message: e.message };
  }

  if (triggerConfig.method === 'pet-panel') {
    detail.available = rawResult.available !== false;
    detail.accepted = !!rawResult.success;
    detail.response = rawResult.response || { code: -1, message: rawResult.reason || '宠物面板指令失败' };
    detail.reason = rawResult.reason || detail.response.message || '';
    detail.panelMeta = rawResult.panelMeta || null;
    detail.panelCommandMeta = rawResult.panelCommandMeta || null;
  } else {
    const normalized = simplifyApiResponse(rawResult);
    detail.accepted = normalized.code === 0;
    detail.response = normalized;
    detail.reason = normalized.message || (detail.accepted ? '直播弹幕已发送' : '直播弹幕发送失败');
  }

  console.log(`   ${triggerConfig.label}: ${detail.accepted ? '✅ 已发出' : '⚠️ 未发出'} (${detail.method} / ${detail.response?.code ?? 'n/a'})`);

  if (!detail.accepted) {
    return detail;
  }

  let previousEnergyRaw = beforeEnergyRaw;

  for (let round = 1; round <= maxVerifyRounds; round++) {
    console.log(`   ⏱️  等待 ${Math.round(waitMs / 1000)} 秒后进行第 ${round} 次经验复查...`);
    await new Promise(r => setTimeout(r, waitMs));

    const heartbeatAfter = await sendActiveRoomHeartbeat(roomInfo || roomId);
    detail.heartbeatAfter = heartbeatAfter;
    console.log(`   ${triggerConfig.label}第 ${round} 次复查前心跳: ${heartbeatAfter.success ? '✅ 成功' : '⚠️ 失败'} (${heartbeatAfter.method || 'none'} / ${heartbeatAfter.response?.code})`);

    const afterEnergyRaw = await getPetEnergy(roomId, { silent: true, debugTarget: energyDebug });
    detail.energyAfter = simplifyPetEnergy(afterEnergyRaw);
    if (detail.energyAfter) {
      console.log(`   ${triggerConfig.label}第 ${round} 次复查后经验: ${detail.energyAfter.current}/${detail.energyAfter.full} | Lv.${detail.energyAfter.level} ${detail.energyAfter.levelName}`);
    }

    detail.gainCheck = evaluateCultivationGain(beforeEnergyRaw, afterEnergyRaw, {
      round,
      maxRounds: maxVerifyRounds,
      waitMs,
      previousEnergy: previousEnergyRaw
    });
    detail.verificationChecks.push({
      round,
      heartbeatAfter,
      energyAfter: detail.energyAfter,
      gainCheck: detail.gainCheck
    });
    detail.active = detail.gainCheck.verified;
    detail.reason = detail.gainCheck.reason || detail.reason;

    const totalDeltaText = Number.isFinite(detail.gainCheck.delta) ? `累计 +${detail.gainCheck.delta}` : '累计增量未知';
    const windowDeltaText = Number.isFinite(detail.gainCheck.windowDelta) ? `本轮 +${detail.gainCheck.windowDelta}` : '本轮增量未知';
    console.log(`   ${triggerConfig.label}第 ${round} 次校验: ${detail.active ? '✅ 已确认修炼成功' : '⚠️ 未确认修炼成功'} - ${totalDeltaText} / ${windowDeltaText} - ${detail.reason}`);

    if (detail.active || !detail.gainCheck.needsAnotherCheck) {
      break;
    }

    if (afterEnergyRaw) {
      previousEnergyRaw = afterEnergyRaw;
    }
  }

  return detail;
}

async function sendPetPanelCommand(roomId, commandInputId, options = {}) {

  const silent = options.silent === true;
  const warn = (...args) => { if (!silent) console.warn(...args); };

  try {
    const panelMeta = await getPetPanelMeta(roomId, { silent });
    if (!panelMeta || !panelMeta.panelUrl) {
      return {
        available: false,
        success: false,
        response: { code: -1, message: '未拿到可用的宠物面板链接' },
        reason: '未拿到可用的宠物面板链接'
      };
    }

    const fetchPanelHtml = async (targetUrl) => {
      const target = new URL(targetUrl);
      const panelPage = await request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `https://live.bilibili.com/${roomId}`
        }
      }, null, { silent: true });
      return panelPage?.raw || '';
    };

    let finalPanelUrl = panelMeta.panelUrl;
    let panelHtml = await fetchPanelHtml(finalPanelUrl);
    let redirectMatch = panelHtml.match(/Object moved to <a href="([^"]+)"/i);
    let redirectCount = 0;
    while (redirectMatch && redirectCount < 3) {
      redirectCount += 1;
      finalPanelUrl = new URL(redirectMatch[1], finalPanelUrl).toString();
      panelHtml = await fetchPanelHtml(finalPanelUrl);
      redirectMatch = panelHtml.match(/Object moved to <a href="([^"]+)"/i);
    }

    const serverUrl = extractHtmlInputValue(panelHtml, 'serverurl');
    const isPetMsg = extractHtmlInputValue(panelHtml, 'lblIsPetMsg');
    const commandMode = extractHtmlInputValue(panelHtml, 'PetCmdMt') || '2';
    const commandPayload = extractHtmlInputValue(panelHtml, commandInputId);

    if (!serverUrl || isPetMsg !== 'True' || !commandPayload) {
      return {
        available: false,
        success: false,
        response: { code: -1, message: '当前直播间宠物面板未提供可用的修炼指令通道' },
        reason: '当前直播间宠物面板未提供可用的修炼指令通道',
        panelMeta: {
          roomId: String(roomId),
          detection: panelMeta.detection || '',
          gameId: panelMeta.gameId || '',
          gameName: panelMeta.gameName || '',
          panelUrl: panelMeta.panelUrl ? truncateText(panelMeta.panelUrl, 220) : ''
        },

        panelCommandMeta: {
          serverUrl: truncateText(serverUrl, 120),
          isPetMsg,
          commandMode,
          commandInputId,
          redirectCount,
          finalPanelUrl: truncateText(finalPanelUrl, 220)
        }
      };
    }

    const body = `j=${encodeURIComponent(commandPayload)}`;
    const panelUrlObj = new URL(finalPanelUrl);
    const res = await request({
      hostname: serverUrl,
      path: `/command.ashx?t=danmu&mt=${encodeURIComponent(commandMode)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'Referer': finalPanelUrl,
        'Origin': `${panelUrlObj.protocol}//${panelUrlObj.host}`
      }
    }, body, { silent: true });

    const normalized = simplifyPetPanelCommandResponse(res);
    return {
      available: true,
      success: normalized.code === 0,
      response: normalized,
      reason: normalized.code === 0 ? '宠物面板已接收指令' : (normalized.message || '宠物面板指令失败'),
      panelMeta: {
        roomId: String(roomId),
        detection: panelMeta.detection || '',
        gameId: panelMeta.gameId || '',
        gameName: panelMeta.gameName || '',
        panelUrl: panelMeta.panelUrl ? truncateText(panelMeta.panelUrl, 220) : ''
      },

      panelCommandMeta: {
        serverUrl: truncateText(serverUrl, 120),
        isPetMsg,
        commandMode,
        commandInputId,
        redirectCount,
        finalPanelUrl: truncateText(finalPanelUrl, 220)
      }
    };
  } catch (e) {
    warn(`   ⚠️  宠物面板指令异常: ${e.message}`);
    return {
      available: false,
      success: false,
      response: { code: -1, message: e.message },
      reason: e.message
    };
  }
}

// 发直播间弹幕

function sendDanmu(roomId, msg) {
  const postData = `bubble=0&msg=${encodeURIComponent(msg)}&color=16777215&mode=1&fontsize=50&rnd=${Math.floor(Date.now()/1000)}&roomid=${roomId}&csrf=${CSRF}&csrf_token=${CSRF}`;
  return request({
    hostname: 'api.live.bilibili.com',
    path: '/msg/send',
    method: 'POST',
    headers: {
      ...buildHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com',
        'Content-Length': Buffer.byteLength(postData)
      })
    }
  }, postData);
}

async function attemptBreakthroughUpgrade(roomId, energy) {
  const detail = {
    attempted: false,
    success: false,
    roomId: String(roomId || ''),
    energy: simplifyPetEnergy(energy),
    planOrder: ['宠物面板「突破」', '直播弹幕「突破」'],
    executedOrder: [],
    method: '',
    reason: '',
    response: null,
    panelMeta: null,
    panelCommandMeta: null,
    panelResponse: null,
    fallbackAttempted: false,
    fallbackResponse: null
  };

  if (!energy) {
    detail.reason = '未拿到可用经验结果，暂不盲目发送突破';
    return detail;
  }

  if (!energy.isFull) {
    detail.reason = `修炼经验未满 (${energy.current}/${energy.full})，无需突破`;
    return detail;
  }

  if (!roomId) {
    detail.reason = '修炼经验已满，但缺少可用房间号，暂未发送突破';
    return detail;
  }

  detail.attempted = true;
  console.log(`   🎉 修炼经验已满 (${energy.current}/${energy.full})，优先尝试宠物面板突破...`);

  detail.executedOrder.push('宠物面板「突破」');
  const panelBreakthroughRes = await sendPetPanelCommand(roomId, 'lblTpMsg', { silent: true });
  detail.panelMeta = panelBreakthroughRes.panelMeta || null;
  detail.panelCommandMeta = panelBreakthroughRes.panelCommandMeta || null;
  detail.panelResponse = panelBreakthroughRes.response || { code: -1, message: panelBreakthroughRes.reason || '宠物面板突破失败' };

  if (panelBreakthroughRes.success) {
    detail.success = true;
    detail.method = 'pet-panel';
    detail.response = detail.panelResponse;
    detail.reason = '已通过宠物面板发送突破指令';
    console.log(`   突破指令返回: code=${detail.response?.code}, msg=${detail.response?.message || ''}`);
    console.log('   ✅ 宠物面板突破成功！');
    return detail;
  }

  detail.fallbackAttempted = true;
  detail.executedOrder.push('直播弹幕「突破」');
  console.warn(`   ⚠️  宠物面板突破未成功：${panelBreakthroughRes.reason || detail.panelResponse?.message || '未知原因'}，改用直播弹幕“突破”兜底`);

  try {
    const btRes = await sendDanmu(roomId, '突破');
    detail.method = 'bilibili-danmu';
    detail.fallbackResponse = simplifyApiResponse(btRes);
    detail.response = detail.fallbackResponse;
    detail.success = btRes.code === 0;
    detail.reason = detail.success
      ? '宠物面板突破失败，已回退到直播弹幕突破并发送成功'
      : `宠物面板突破失败，直播弹幕突破也失败：${detail.fallbackResponse?.message || '未知原因'}`;
    console.log(`   突破弹幕返回: code=${btRes.code}, msg=${btRes.message || btRes.msg || ''}`);
    if (detail.success) {
      console.log('   ✅ 直播弹幕突破成功！');
    }
  } catch (e) {
    detail.method = 'bilibili-danmu';
    detail.fallbackResponse = { code: -1, message: e.message };
    detail.response = detail.fallbackResponse;
    detail.reason = `宠物面板突破失败，且直播弹幕突破异常：${e.message}`;
    console.warn('   突破弹幕异常:', e.message);
  }

  return detail;
}


// ==============================
// 验证登录状态
// ==============================

async function checkLogin() {
  console.log('\n📋 验证登录状态...');
  if (!COOKIE) {
    console.error('');
    console.error('🚨🚨🚨 ===== COOKIE 未配置 ===== 🚨🚨🚨');
    console.error('❌ BILIBILI_COOKIE 未配置！');
    console.error('👉 请前往 GitHub → Settings → Secrets → 添加 BILIBILI_COOKIE');
    console.error('🚨🚨🚨 ========================= 🚨🚨🚨');
    return false;
  }
  if (!CSRF) {
    console.error('');
    console.error('🚨🚨🚨 ===== COOKIE 格式错误 ===== 🚨🚨🚨');
    console.error('❌ Cookie 中未找到 bili_jct，Cookie 格式不完整');
    console.error('👉 请重新从浏览器获取完整 Cookie 并更新 Secrets');
    console.error('🚨🚨🚨 ============================ 🚨🚨🚨');
    return false;
  }
  try {
    const res = await apiGet('/x/web-interface/nav');
    if (res.code === 0 && res.data && res.data.isLogin) {
      console.log(`✅ 登录成功！用户: ${res.data.uname}（UID: ${res.data.mid}）`);
      // 顺便打印 Cookie 大概剩余有效期（从SESSDATA过期时间估算）
      const sessdataMatch = COOKIE.match(/SESSDATA=([^;]+)/);
      if (sessdataMatch) {
        console.log('   Cookie 状态: 有效 ✅');
      }
      return true;
    } else if (res.code === -101 || (res.data && res.data.isLogin === false)) {
      console.error('');
      console.error('🚨🚨🚨 ===== COOKIE 已失效 ===== 🚨🚨🚨');
      console.error('❌ B站 Cookie 已过期，账号未登录！');
      console.error('👉 操作步骤：');
      console.error('   1. 打开浏览器，登录 bilibili.com');
      console.error('   2. F12 → Application → Cookies → bilibili.com');
      console.error('   3. 复制完整 Cookie 字符串');
      console.error('   4. 前往 GitHub 仓库 → Settings → Secrets and variables → Actions → 更新 BILIBILI_COOKIE');
      console.error(`   返回码: ${res.code}`);
      console.error('🚨🚨🚨 ========================= 🚨🚨🚨');
      // 发送邮件通知
      await sendMail(
        '【B站自动化】⚠️ Cookie 已失效，请及时更新',
        `您的 B站 Cookie 已过期，自动化任务已停止运行。\n\n请按以下步骤更新：\n1. 打开浏览器，登录 bilibili.com\n2. F12 → Application → Cookies → bilibili.com\n3. 复制完整 Cookie 字符串\n4. 前往 GitHub 仓库 → Settings → Secrets and variables → Actions → 更新 BILIBILI_COOKIE\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      );

      return false;
    } else {
      console.error('');
      console.error('🚨🚨🚨 ===== 登录验证失败 ===== 🚨🚨🚨');
      console.error(`❌ 登录验证失败，code=${res.code}，message=${res.message}`);
      console.error('👉 可能原因：Cookie 已过期或 B站 API 异常，请检查 Cookie 是否有效');
      console.error('🚨🚨🚨 ========================= 🚨🚨🚨');
      return false;
    }
  } catch (e) {
    console.error('');
    console.error('🚨🚨🚨 ===== 网络请求失败 ===== 🚨🚨🚨');
    console.error('❌ 验证登录失败：', e.message);
    console.error('👉 可能是网络问题，稍后会自动重试');
    console.error('🚨🚨🚨 ========================= 🚨🚨🚨');
    return false;
  }
}

// ==============================
// 检测直播间是否开播
// ==============================
async function getRoomLiveStatus(roomId) {
  try {
    const res = await request({
      hostname: 'api.live.bilibili.com',
      path: `/xlive/web-room/v1/index/getInfoByRoom?room_id=${roomId}`,
      method: 'GET',
      headers: buildHeaders({
        'Referer': `https://live.bilibili.com/${roomId}`,
        'Origin': 'https://live.bilibili.com',
      })
    });
    if (res.code === 0 && res.data && res.data.room_info) {
      const ri = res.data.room_info;
      const ai = res.data.anchor_info;
      return {
        roomId: String(ri.room_id || roomId),
        shortRoomId: String(ri.short_id || ''),
        isLive: ri.live_status === 1,
        liveStatus: ri.live_status,
        title: ri.title || '',
        anchorName: ai ? ai.base_info.uname : '',
        anchorUid: String(ri.uid || ''),
        parentAreaId: Number(ri.parent_area_id || 0),
        areaId: Number(ri.area_id || 0),
        online: ri.online || 0,
      };
    }
    return null;
  } catch(e) {
    console.warn(`   ⚠️  获取直播间状态失败: ${e.message}`);
    return null;
  }
}


// ==============================
// 直播间每日粉丝勋章签到（领金币/亲密度）
// ==============================
async function doLiveMedalCheckin() {
  console.log('\n   🏅 执行直播间粉丝勋章签到...');
  try {
    const body = `csrf=${CSRF}&csrf_token=${CSRF}`;
    const res = await request({
      hostname: 'api.live.bilibili.com',
      path: '/xlive/web-ucenter/v1/sign/DoSign',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Referer': 'https://live.bilibili.com',
          'Origin': 'https://live.bilibili.com',
        })
      }
    }, body);
    if (res.code === 0) {
      const d = res.data || {};
      console.log(`   ✅ 直播签到成功！${d.text || ''}${d.specialText ? ' ' + d.specialText : ''}`);
      return true;
    } else if (res.code === 1011040) {
      console.log('   ℹ️  今日直播签到已完成，跳过');
      return true;
    } else {
      console.warn(`   ⚠️  直播签到返回: ${res.code} - ${res.message || ''}`);
      return false;
    }
  } catch(e) {
    console.warn(`   ⚠️  直播签到异常: ${e.message}`);
    return false;
  }
}

async function enterRoom(roomId) {
  try {
    const body = `room_id=${roomId}&platform=pc&csrf=${CSRF}&csrf_token=${CSRF}`;
    const res = await request({
      hostname: 'api.live.bilibili.com',
      path: '/xlive/web-room/v1/index/roomEntryAction',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com',
        })
      }
    }, body);

    return {
      success: res.code === 0,
      response: simplifyApiResponse(res)
    };
  } catch (e) {
    return {
      success: false,
      response: { code: -1, message: e.message }
    };
  }
}

async function sendActiveRoomHeartbeat(roomInfoOrRoomId) {
  const roomInfo = typeof roomInfoOrRoomId === 'object' && roomInfoOrRoomId !== null
    ? roomInfoOrRoomId
    : await getRoomLiveStatus(roomInfoOrRoomId);

  const roomId = String(roomInfo && roomInfo.roomId ? roomInfo.roomId : roomInfoOrRoomId);
  const detail = {
    success: false,
    method: '',
    response: null,
    roomMeta: roomInfo ? {
      roomId,
      anchorUid: roomInfo.anchorUid || '',
      parentAreaId: roomInfo.parentAreaId || 0,
      areaId: roomInfo.areaId || 0,
    } : null,
    attempts: []
  };

  const pushAttempt = (method, res, extra = {}) => {
    const simplified = simplifyApiResponse(res);
    detail.attempts.push({
      method,
      ...extra,
      response: simplified
    });
    if (res && res.code === 0 && !detail.success) {
      detail.success = true;
      detail.method = method;
      detail.response = simplified;
    }
  };

  try {
    const webBody = `visit_id=&room_id=${roomId}`;
    const webRes = await request({
      hostname: 'api.live.bilibili.com',
      path: '/xlive/web-room/v2/index/webHeartBeat',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(webBody),
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com',
        })
      }
    }, webBody);
    pushAttempt('webHeartBeat', webRes);
    if (detail.success) return detail;
  } catch (e) {
    pushAttempt('webHeartBeat', { code: -1, message: e.message });
  }

  const anchorUid = Number(roomInfo && roomInfo.anchorUid ? roomInfo.anchorUid : 0);
  const parentAreaId = Number(roomInfo && roomInfo.parentAreaId ? roomInfo.parentAreaId : 0) || 1;
  const areaId = Number(roomInfo && roomInfo.areaId ? roomInfo.areaId : 0) || 1;

  if (anchorUid > 0) {
    try {
      const userOnlineBody = JSON.stringify({
        room_id: Number(roomId),
        parent_id: parentAreaId,
        area_id: areaId,
        ruid: anchorUid,
        csrf_token: CSRF,
        csrf: CSRF,
        visit_id: generateUUID()
      });
      const userOnlineRes = await request({
        hostname: 'api.live.bilibili.com',
        path: '/xlive/web-ucenter/v1/sign/UserOnlineHeartBeat',
        method: 'POST',
        headers: {
          ...buildHeaders({
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(userOnlineBody),
            'Referer': `https://live.bilibili.com/${roomId}`,
            'Origin': 'https://live.bilibili.com',
          })
        }
      }, userOnlineBody);
      pushAttempt('UserOnlineHeartBeat', userOnlineRes, {
        meta: { anchorUid, parentAreaId, areaId }
      });
      if (detail.success) return detail;
    } catch (e) {
      pushAttempt('UserOnlineHeartBeat', { code: -1, message: e.message }, {
        meta: { anchorUid, parentAreaId, areaId }
      });
    }
  } else {
    detail.attempts.push({
      method: 'UserOnlineHeartBeat',
      skipped: true,
      reason: '缺少主播 UID，无法构造用户在线心跳'
    });
  }

  try {
    const feedBody = `room_id=${roomId}&csrf_token=${CSRF}&csrf=${CSRF}`;
    const feedRes = await request({
      hostname: 'api.live.bilibili.com',
      path: '/relation/v1/Feed/heartBeat',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(feedBody),
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com',
        })
      }
    }, feedBody);
    pushAttempt('Feed.heartBeat', feedRes);
  } catch (e) {
    pushAttempt('Feed.heartBeat', { code: -1, message: e.message });
  }

  if (!detail.response) {
    const lastAttempt = detail.attempts[detail.attempts.length - 1];
    detail.response = lastAttempt ? lastAttempt.response || { code: -1, message: '心跳未执行' } : { code: -1, message: '心跳未执行' };
  }

  return detail;
}


// ==============================
// 任务1：直播挂机修炼（发弹幕）
// 流程：检测直播间开播 → 关播自动换 → 进场 → 心跳 → 发修仙弹幕 → 再次心跳 → 查询经验
// ==============================

async function doHangup() {
  console.log('\n🎯 ======== 直播挂机修炼 ========');
  console.log(`   配置直播间: ${HANGUP_ROOM_ID}`);
  if (PET_PRIORITY_ROOMS.length > 0) {
    console.log(`   历史 +19 优先房间: ${PET_PRIORITY_ROOMS.join(', ')}`);
  }

  const detail = {
    configuredRoomId: String(HANGUP_ROOM_ID),
    priorityRoomsConfigured: PET_PRIORITY_ROOMS,
    priorityRoomSuggestion: null,
    resolvedRoom: null,
    roomResolution: {
      configuredRoom: null,
      scan: null,
    },

    roomAttempts: [],

    roomHeartbeatMeta: null,
    liveCheckin: null,
    enterRoom: null,
    heartbeatBeforeDanmu: null,
    hangupDanmu: null,
    heartbeatAfterDanmu: null,
    energyAfterHangup: null,
    cultivationCheck: null,
    energyDebug: {},
    triggerPlanOrder: [],
    triggerExecutedOrder: [],
    breakthroughPlanOrder: ['宠物面板「突破」', '直播弹幕「突破」'],
    breakthrough: null,
    randomHeartbeat: null,
    success: false,
    reason: ''
  };



  setRunDetail('hangup', detail);

  detail.liveCheckin = { success: await doLiveMedalCheckin() };

  const attemptedRoomIds = [];
  let petRoom = await resolvePetRoom('挂机修炼', { debugTarget: detail.roomResolution });

  let activeRoomId = '';
  let activeRoomInfo = null;
  let confirmedEnergy = null;
  let breakthroughRoomId = '';
  let breakthroughEnergy = null;
  const rememberBreakthroughCandidate = (roomId, energy) => {
    if (!energy || !energy.isFull) return;
    breakthroughRoomId = String(roomId || '');
    breakthroughEnergy = { ...energy };
  };

  if (!petRoom) {

    console.error('❌ 未找到正在开播且已开启弹幕宠物的直播间');
    detail.reason = '未找到正在开播且已开启弹幕宠物的直播间';
    if (detail.energyDebug && Object.keys(detail.energyDebug).length === 0) {
      detail.energyDebug = null;
    }
    return false;
  }

  while (petRoom && attemptedRoomIds.length < 3) {

    const candidateRoomId = String(petRoom.roomId);
    const attempt = {
      roomId: candidateRoomId,
      title: petRoom.title || '',
      anchorName: petRoom.anchorName || '',
      switched: !!petRoom.switched,
      switchedFrom: petRoom.switchedFrom || null,
      source: petRoom.source || '',
      petDetection: petRoom.petDetection || '',
      petGameId: petRoom.petGameId || '',
      petGameName: petRoom.petGameName || '',
      priorityPinned: !!petRoom.priorityPinned,
      priorityIndex: typeof petRoom.priorityIndex === 'number' ? petRoom.priorityIndex : -1,
      priorityReason: petRoom.priorityReason || '',
      roomHeartbeatMeta: null,

      enterRoom: null,
      heartbeatBeforeDanmu: null,
      hangupDanmu: null,
      heartbeatAfterDanmu: null,
      energyBeforeDanmu: null,
      energyAfterDanmu: null,
      cultivationCheck: null,
      switchReason: ''
    };
    detail.roomAttempts.push(attempt);

    console.log(`   当前直播间: ${candidateRoomId}（${petRoom.title || petRoom.anchorName || '未知直播间'}）`);
    if (petRoom.priorityPinned) {
      console.log(`   📌 历史 +19 优先命中：${petRoom.priorityReason || '已命中优先房间列表'}`);
    }
    if (petRoom.switched) {
      console.log(`   自动切换: ${petRoom.switchedFrom} → ${candidateRoomId}（来源：${petRoom.source}）`);
    }


    activeRoomInfo = await getRoomLiveStatus(candidateRoomId);
    attempt.roomHeartbeatMeta = activeRoomInfo ? {
      roomId: activeRoomInfo.roomId,
      shortRoomId: activeRoomInfo.shortRoomId,
      anchorUid: activeRoomInfo.anchorUid,
      parentAreaId: activeRoomInfo.parentAreaId,
      areaId: activeRoomInfo.areaId,
      liveStatus: activeRoomInfo.liveStatus
    } : null;

    console.log('\n   先执行进场与目标直播间心跳，避免只发指令但没有留下在线记录');
    attempt.enterRoom = await enterRoom(candidateRoomId);
    console.log(`   进场记录: ${attempt.enterRoom.success ? '✅ 成功' : '⚠️ 失败'} (${attempt.enterRoom.response?.code})`);

    attempt.heartbeatBeforeDanmu = await sendActiveRoomHeartbeat(activeRoomInfo || candidateRoomId);
    console.log(`   首次心跳: ${attempt.heartbeatBeforeDanmu.success ? '✅ 成功' : '⚠️ 失败'} (${attempt.heartbeatBeforeDanmu.method || 'none'} / ${attempt.heartbeatBeforeDanmu.response?.code})`);

    console.log(`\n   依次尝试宠物面板 + 真实直播弹幕，确认是否真正进入有效修炼档位（排除 +14 倍数滞后显示）：${candidateRoomId}`);
    attempt.hangupDanmu = {
      success: false,
      active: false,
      method: '',
      reason: '',
      response: null,
      panelMeta: null,
      panelCommandMeta: null,
      gainCheck: null,
      planOrder: [],
      executedOrder: [],
      triggers: []

    };

    const triggerPlans = [
      {
        method: 'pet-panel',
        label: '宠物面板「修仙」',
        execute: () => sendPetPanelCommand(candidateRoomId, 'lblXxMsg')
      },
      {
        method: 'bilibili-danmu',
        label: '直播弹幕「修炼」',
        danmuText: '修炼',
        execute: () => sendDanmu(candidateRoomId, '修炼')
      },
      {
        method: 'bilibili-danmu',
        label: '直播弹幕「修仙」',
        danmuText: '修仙',
        execute: () => sendDanmu(candidateRoomId, '修仙')
      }
    ];
    const triggerPlanOrder = triggerPlans.map((item) => item.label || item.method || '');
    attempt.hangupDanmu.planOrder = [...triggerPlanOrder];
    detail.triggerPlanOrder = [...triggerPlanOrder];

    for (const triggerPlan of triggerPlans) {

      attempt.hangupDanmu.executedOrder.push(triggerPlan.label || triggerPlan.method || '');
      detail.triggerExecutedOrder.push(`${candidateRoomId}:${triggerPlan.label || triggerPlan.method || ''}`);
      const triggerAttempt = await triggerCultivationAttempt(candidateRoomId, activeRoomInfo || candidateRoomId, triggerPlan, {
        energyDebug: detail.energyDebug,
        waitMs: 12000,
        maxVerifyRounds: 2
      });
      attempt.hangupDanmu.triggers.push(triggerAttempt);


      if (!attempt.energyBeforeDanmu && triggerAttempt.energyBefore) {
        attempt.energyBeforeDanmu = triggerAttempt.energyBefore;
      }
      rememberBreakthroughCandidate(candidateRoomId, triggerAttempt.energyBefore);
      if (triggerAttempt.heartbeatAfter) {
        attempt.heartbeatAfterDanmu = triggerAttempt.heartbeatAfter;
      }
      if (triggerAttempt.energyAfter) {
        attempt.energyAfterDanmu = triggerAttempt.energyAfter;
      }
      rememberBreakthroughCandidate(candidateRoomId, triggerAttempt.energyAfter);

      if (triggerAttempt.gainCheck) {
        attempt.cultivationCheck = triggerAttempt.gainCheck;
        attempt.hangupDanmu.gainCheck = triggerAttempt.gainCheck;
      }
      if (!attempt.hangupDanmu.panelMeta && triggerAttempt.panelMeta) {
        attempt.hangupDanmu.panelMeta = triggerAttempt.panelMeta;
      }
      if (!attempt.hangupDanmu.panelCommandMeta && triggerAttempt.panelCommandMeta) {
        attempt.hangupDanmu.panelCommandMeta = triggerAttempt.panelCommandMeta;
      }

      if (triggerAttempt.active) {
        attempt.hangupDanmu.success = true;
        attempt.hangupDanmu.active = true;
        attempt.hangupDanmu.method = triggerAttempt.method;
        attempt.hangupDanmu.reason = triggerAttempt.reason || '';
        attempt.hangupDanmu.response = triggerAttempt.response;
        break;
      }

      if (triggerAttempt.accepted) {
        attempt.hangupDanmu.success = true;
        attempt.hangupDanmu.method = triggerAttempt.method;
        attempt.hangupDanmu.reason = triggerAttempt.reason || '';
        attempt.hangupDanmu.response = triggerAttempt.response;
        console.warn(`   ⚠️  ${triggerPlan.label} 已触发，但两轮 12 秒复查后仍未确认有效修炼增量，继续尝试下一种方式`);
      }
    }

    if (attempt.hangupDanmu.active) {
      activeRoomId = candidateRoomId;
      confirmedEnergy = attempt.energyAfterDanmu ? {
        ...attempt.energyAfterDanmu,
        panelUrl: attempt.hangupDanmu.panelMeta?.panelUrl || ''
      } : null;
      detail.resolvedRoom = {
        roomId: candidateRoomId,
        title: attempt.title,
        anchorName: attempt.anchorName,
        switched: attempt.switched,
        switchedFrom: attempt.switchedFrom,
        source: attempt.source,
        petDetection: attempt.petDetection,
        petGameId: attempt.petGameId,
        petGameName: attempt.petGameName,
        priorityPinned: attempt.priorityPinned,
        priorityIndex: attempt.priorityIndex,
        priorityReason: attempt.priorityReason
      };
      detail.priorityRoomSuggestion = {
        roomId: candidateRoomId,
        alreadyPinned: PET_PRIORITY_ROOM_SET.has(candidateRoomId),
        suggestedPriorityRooms: Array.from(new Set([candidateRoomId, ...PET_PRIORITY_ROOMS])),
        reason: PET_PRIORITY_ROOM_SET.has(candidateRoomId)
          ? '该房间本来就已在历史 +19 优先列表中，这次再次确认有效'
          : '该房间本次已确认打到 +19，建议加入 PET_PRIORITY_ROOMS 并放到最前面'
      };
      detail.roomHeartbeatMeta = attempt.roomHeartbeatMeta;
      detail.enterRoom = attempt.enterRoom;
      detail.heartbeatBeforeDanmu = attempt.heartbeatBeforeDanmu;
      detail.hangupDanmu = attempt.hangupDanmu;
      detail.heartbeatAfterDanmu = attempt.heartbeatAfterDanmu;
      detail.energyAfterHangup = attempt.energyAfterDanmu;
      detail.cultivationCheck = attempt.cultivationCheck;
      break;
    }



    attemptedRoomIds.push(candidateRoomId);
    attempt.switchReason = attempt.hangupDanmu.reason || '宠物面板与真实弹幕都尝试过，但两轮 12 秒复查后仍未确认有效修炼增量';
    console.warn(`   ⚠️  房间 ${candidateRoomId} 未确认进入修炼状态，准备更换到下一个已开启弹幕宠物的直播间`);


    const excludeRoomIds = Array.from(new Set([String(HANGUP_ROOM_ID), ...attemptedRoomIds]));
    petRoom = await findActivePetRoom(excludeRoomIds);
    if (petRoom) {
      console.log(`   🔄 已切换候选直播间: ${candidateRoomId} → ${petRoom.roomId}`);
    }
  }

  console.log('\n   🔍 根据经验结果，判断是否需要突破...');
  const energyForBreakthrough = confirmedEnergy || breakthroughEnergy;
  const roomIdForBreakthrough = activeRoomId || breakthroughRoomId;
  if (detail.energyDebug && Object.keys(detail.energyDebug).length === 0) {
    detail.energyDebug = null;
  }

  detail.breakthrough = await attemptBreakthroughUpgrade(roomIdForBreakthrough, energyForBreakthrough);
  detail.breakthroughPlanOrder = detail.breakthrough?.planOrder || detail.breakthroughPlanOrder;
  if (!detail.breakthrough?.attempted) {

    console.log(`   ℹ️  ${detail.breakthrough?.reason || '当前无需突破'}`);
  }

  if (!activeRoomId) {
    console.error('❌ 面板与真实弹幕触发后仍未确认进入修炼状态');
    if (detail.breakthrough?.success) {
      detail.reason = '本轮未确认进入修炼状态，但检测到经验已满并已触发突破升级';
    } else if (detail.breakthrough?.attempted) {
      detail.reason = `宠物面板与真实弹幕都尝试过，但两轮 12 秒复查后仍未确认有效修炼增量；同时经验已满，但突破未成功：${detail.breakthrough.reason || '未知原因'}`;
    } else {
      detail.reason = '宠物面板与真实弹幕都尝试过，但两轮 12 秒复查后仍未确认有效修炼增量，已尝试切换直播间';
    }
    return false;
  }

  detail.randomHeartbeat = await doRandomRoomHeartbeat();
  detail.success = !!detail.hangupDanmu?.active;
  if (detail.success) {
    if (detail.breakthrough?.success) {
      detail.reason = '已通过最多两轮 12 秒经验复查确认修炼成功，且经验已满并已触发突破升级';
    } else if (detail.breakthrough?.attempted) {
      detail.reason = `已通过最多两轮 12 秒经验复查确认修炼成功，但经验已满后的突破未成功：${detail.breakthrough.reason || '未知原因'}`;
    } else {
      detail.reason = '已通过最多两轮 12 秒经验复查确认修炼成功；若仍只出现 +14 基础收益或 +14 倍数滞后显示，会自动切换到其他开启弹幕宠物的直播间';
    }
  } else {
    detail.reason = '两轮 12 秒经验复查后仍未达到有效修炼成功档位';
  }


  return detail.success;
}




// ==============================
// 随机直播间心跳（获取B站直播经验）
// ==============================
async function doRandomRoomHeartbeat() {
  console.log('\n   💓 随机直播间心跳...');
  const roomId = RANDOM_ROOMS[Math.floor(Math.random() * RANDOM_ROOMS.length)];
  console.log(`   随机选中直播间: ${roomId}（共 ${RANDOM_ROOMS.length} 个可选）`);

  const detail = {
    roomId: String(roomId),
    primary: null,
    fallback: null,
    success: false
  };

  try {
    const body = `room_id=${roomId}&csrf_token=${CSRF}&csrf=${CSRF}`;
    const res = await request({
      hostname: 'api.live.bilibili.com',
      path: '/relation/v1/Feed/heartBeat',
      method: 'POST',
      headers: {
        ...buildHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://live.bilibili.com/${roomId}`,
          'Origin': 'https://live.bilibili.com',
          'Content-Length': Buffer.byteLength(body)
        })
      }
    }, body);
    detail.primary = simplifyApiResponse(res);
    console.log(`   心跳返回: code=${res.code}, msg=${res.message || res.msg || ''}`);
    if (res.code === 0) {
      console.log(`   ✅ 直播心跳成功（直播间 ${roomId}）`);
      detail.success = true;
      return detail;
    }

    const info = await request({
      hostname: 'api.live.bilibili.com',
      path: `/room/v1/Room/room_init?id=${roomId}`,
      method: 'GET',
      headers: buildHeaders({
        'Referer': `https://live.bilibili.com/${roomId}`
      })
    });
    detail.fallback = simplifyApiResponse(info);
    console.log(`   备用心跳返回: code=${info.code}（直播间 ${roomId}）`);
    if (info.code === 0) {
      console.log('   ✅ 直播间在线记录成功');
      detail.success = true;
    }
  } catch (e) {
    detail.primary = detail.primary || { code: -1, message: e.message };
    console.warn(`   直播心跳异常: ${e.message}`);
  }

  return detail;
}


// 生成随机UUID（心跳用）
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ==============================
// 任务3：宠物签到（发签到弹幕）
// ==============================
async function doPetGrowth() {
  console.log('\n🎯 ======== 弹幕宠物签到 ========');
  console.log(`   配置直播间: ${HANGUP_ROOM_ID}`);
  console.log(`   方式: 发送「${SIGNIN_DANMU}」弹幕`);

  const petRoom = await resolvePetRoom('宠物签到');
  if (!petRoom) {
    console.error('❌ 本次未找到可用的弹幕宠物直播间，跳过宠物签到');
    return false;
  }

  const activeRoomId = petRoom.roomId;
  console.log(`   当前直播间: ${activeRoomId}（${petRoom.title || petRoom.anchorName || '未知直播间'}）`);

  try {
    const res = await sendDanmu(activeRoomId, SIGNIN_DANMU);
    console.log(`   [HTTP] 签到弹幕返回: code=${res.code}, msg=${res.message || res.msg || ''}`);

    if (res.code === 0) {
      console.log('✅ 宠物签到弹幕发送成功！');
      return true;
    } else if (res.code === 10031) {
      console.log('⚠️  弹幕发送频繁限制，稍后重试...');
      await new Promise(r => setTimeout(r, 10000));
      const res2 = await sendDanmu(activeRoomId, SIGNIN_DANMU);
      if (res2.code === 0) {
        console.log('✅ 重试成功！宠物签到弹幕已发送');
        return true;
      }
      console.warn(`⚠️  重试仍失败: ${res2.code}`);
      return false;
    } else if (res.code === -101) {
      console.error('❌ 未登录，Cookie 已过期');
      return false;
    } else {
      console.warn(`⚠️  签到弹幕返回: ${res.code} - ${res.message || ''}`);
      return false;
    }
  } catch (e) {
    console.error('❌ 宠物签到异常：', e.message);
    return false;
  }
}

// ==============================
// 主函数
// ==============================
async function main() {
  RUN_DETAILS = {
    task: TASK,
    startedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  };

  console.log('🚀 B站自动化工具启动');
  console.log(`⏰ 时间: ${RUN_DETAILS.startedAt}`);
  console.log(`🎯 执行任务: ${TASK}`);
  console.log('='.repeat(50));

  const loggedIn = await checkLogin();
  RUN_DETAILS.login = { success: loggedIn };
  if (!loggedIn) {
    console.error('\n❌ 登录验证失败，退出执行');
    console.error('请检查: 1) Cookie 是否正确配置到 GitHub Actions Secrets 2) Cookie 是否已过期');
    throw new Error('登录验证失败');
  }


  const results = {};

  if (TASK === 'all' || TASK === 'hangup') {
    results.hangup = await doHangup();
  }

  if (TASK === 'all' || TASK === 'pet') {
    results.pet = await doPetGrowth();
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 执行结果汇总:');
  if ('hangup' in results) console.log(`   挂机: ${results.hangup ? '✅ 成功' : '❌ 失败'}`);
  if ('pet' in results) console.log(`   宠物: ${results.pet ? '✅ 成功' : '❌ 失败'}`);

  const allSuccess = Object.values(results).every(v => v);
  console.log(`\n${allSuccess ? '🎉 所有任务执行成功！' : '⚠️  部分任务失败，请查看日志'}`);

  return {
    success: allSuccess,
    task: TASK,
    executedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    results,
    details: RUN_DETAILS
  };
}




// 本地运行支持
if (require.main === module) {
  main()
    .then(summary => {
      if (!summary || summary.success !== true) {
        process.exit(1);
      }
    })
    .catch(err => {
      console.error('❌ 未处理的错误:', err);
      process.exit(1);
    });
}
