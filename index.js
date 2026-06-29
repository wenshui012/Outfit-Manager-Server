// ── 穿搭管理器 · 后端存储插件 v2 ─────────────────────────
// SillyTavern server plugin — 持久化穿搭数据 + 图片分离存储
//
// Phase 2: 分包存储架构
//   meta.json + part_*.json 独立文件，替代单一 outfits.json
//
// 路由（自动挂载在 /api/plugins/outfit-manager/ 之下）：
//   GET    /status              健康探测 + 版本号（version: 2）
//   GET    /data                兼容：从分包重组完整旧格式 JSON
//   PUT    /data                兼容：接受旧完整 JSON，拆成分包写入
//   GET    /partitions/keys     列出所有已有 partition key
//   GET    /partitions/:key     读单个 partition
//   PUT    /partitions/:key     写单个 partition（含图片分离）
//   DELETE /partitions/:key     删除单个 partition
//   POST   /images              单张图片上传（base64 body），返回 URL
//   POST   /images/batch-fetch  批量取图片 base64（导出用）
//   GET    /images/:name        读取单张图片文件
//   POST   /gc                  清理未引用图片（扫描所有分包）
//
// 设计要点：
//   - 图片以 SHA1 内容寻址命名，同图去重
//   - partition key → 文件名：'part_' + key.replace(/:/g, '__') + '.json'
//   - key 严格白名单校验，防路径穿越
//   - 首次升级自动迁移旧 outfits.json → 分包文件 + rename 备份
//   - /data 兼容路由从分包重组/拆解，不再直接读写旧文件
//   - /gc 扫描所有 partition 文件收集图片引用
//   - 只允许 jpg/png/webp/gif/bmp，禁止 SVG（安全考量）
//   - 写文件用 tmp → rename 原子操作

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const info = {
    id: 'outfit-manager',
    name: 'Outfit Manager Storage',
    description: 'Server-side persistence backend for the Outfit Manager extension.',
};

// ── 路径常量 ────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'outfits.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const IMAGE_URL_PREFIX = '/api/plugins/outfit-manager/images/';

// ── 校验正则 ────────────────────────────────────────────
const DATA_URL_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const SAFE_NAME_RE = /^[a-f0-9]{40}\.[a-z0-9]+$/i;

// 允许的图片类型白名单（禁止 SVG）
const ALLOWED_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif', 'bmp']);

// Partition key 白名单正则
// meta | user:__default__ | user:<id> | char:__shared__ | char:c_<8chars>
const VALID_PART_KEY_RE = /^(meta|user:(__default__|[A-Za-z0-9_-]+)|char:(__shared__|c_[A-Za-z0-9]{8}))$/;

// ── 工具函数 ────────────────────────────────────────────
function ensureDirsSync() {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m === 'jpeg' || m === 'jpg' || m === 'pjpeg') return 'jpg';
    if (m === 'png') return 'png';
    if (m === 'webp') return 'webp';
    if (m === 'gif') return 'gif';
    if (m === 'bmp') return 'bmp';
    return null; // 不在白名单则拒绝
}

function isValidImageName(name) {
    if (!SAFE_NAME_RE.test(name)) return false;
    const ext = name.split('.').pop().toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

// ── Partition key ↔ 文件名 ──────────────────────────────

function validatePartKey(key) {
    return typeof key === 'string' && VALID_PART_KEY_RE.test(key);
}

// key → 磁盘文件路径
// meta -> meta.json
// user:__default__ -> part_user____default__.json
// char:c_AbCd1234 -> part_char__c_AbCd1234.json
function partKeyToFile(key) {
    if (key === 'meta') return META_FILE;
    const fileName = 'part_' + key.replace(/:/g, '__') + '.json';
    return path.join(DATA_DIR, fileName);
}

// 文件名 → key（反向解析，/partitions/keys 用）
function fileToPartKey(fileName) {
    if (fileName === 'meta.json') return 'meta';
    if (!fileName.startsWith('part_') || !fileName.endsWith('.json')) return null;
    // part_user____default__.json -> user:__default__
    // part_char__c_AbCd1234.json -> char:c_AbCd1234
    const inner = fileName.slice(5, -5); // 去掉 'part_' 和 '.json'
    // 第一个 __ 是冒号的替换，还原为 :
    // 规则：key 里只有一个冒号，对应文件名里第一个 __
    const idx = inner.indexOf('__');
    if (idx === -1) return null;
    const key = inner.slice(0, idx) + ':' + inner.slice(idx + 2);
    if (!validatePartKey(key)) return null;
    return key;
}

// ── Partition 文件读写 ──────────────────────────────────

async function readPartFile(key) {
    if (!validatePartKey(key)) throw new Error('Invalid partition key: ' + key);
    const filePath = partKeyToFile(key);
    try {
        const buf = await fsp.readFile(filePath, 'utf-8');
        return JSON.parse(buf);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

async function writePartFile(key, obj) {
    if (!validatePartKey(key)) throw new Error('Invalid partition key: ' + key);
    const filePath = partKeyToFile(key);
    const tmp = filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf-8');
    await fsp.rename(tmp, filePath);
}

async function deletePartFile(key) {
    if (!validatePartKey(key)) throw new Error('Invalid partition key: ' + key);
    const filePath = partKeyToFile(key);
    try {
        await fsp.unlink(filePath);
    } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
    }
}

// 列出所有已有的 partition key
async function listPartKeys() {
    const keys = [];
    try {
        const files = await fsp.readdir(DATA_DIR);
        for (const f of files) {
            const key = fileToPartKey(f);
            if (key) keys.push(key);
        }
        // meta.json 单独检查（不走 part_ 前缀）
        try {
            await fsp.access(META_FILE);
            if (keys.indexOf('meta') === -1) keys.push('meta');
        } catch { /* no meta.json */ }
    } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
    }
    return keys;
}

// ── 旧数据文件读写（兼容用）────────────────────────────

async function readLegacyFile() {
    try {
        const buf = await fsp.readFile(LEGACY_DATA_FILE, 'utf-8');
        return JSON.parse(buf);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

// ── 图片存储核心 ────────────────────────────────────────
// 将 base64 dataURL 存为文件，返回 { name, url } 或 null
async function storeBase64Image(dataUrl) {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return null;

    const ext = extFromMime(m[1]);
    if (!ext) return null; // 不在白名单（如 SVG）

    const raw = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    const name = hash + '.' + ext;
    const filePath = path.join(IMAGES_DIR, name);

    try {
        await fsp.access(filePath);
    } catch {
        await fsp.writeFile(filePath, raw);
    }
    return { name: name, url: IMAGE_URL_PREFIX + name };
}

// 读取图片文件返回 dataURL
async function imageToDataUrl(name) {
    if (!isValidImageName(name)) return null;
    const filePath = path.join(IMAGES_DIR, name);
    // 二次路径穿越校验
    if (!filePath.startsWith(IMAGES_DIR + path.sep) && filePath !== path.join(IMAGES_DIR, name)) {
        return null;
    }
    try {
        const buf = await fsp.readFile(filePath);
        const ext = name.split('.').pop().toLowerCase();
        const mimeMap = { jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' };
        const mime = mimeMap[ext] || 'jpeg';
        return 'data:image/' + mime + ';base64,' + buf.toString('base64');
    } catch {
        return null;
    }
}

// ── 图片分离：单个 partition ─────────────────────────────
// 对 outfit partition: 扫描 outfits[*].imageData
// 对 meta: 扫描 fabImage
// 返回 referenced 图片名集合（供 GC 用）

async function externalizePartitionImages(key, data) {
    const referenced = new Set();
    if (!data || typeof data !== 'object') return referenced;

    if (key === 'meta') {
        // meta 里只有 fabImage
        if (typeof data.fabImage === 'string' && data.fabImage) {
            if (data.fabImage.startsWith(IMAGE_URL_PREFIX)) {
                const name = path.basename(data.fabImage);
                if (isValidImageName(name)) referenced.add(name);
            } else if (DATA_URL_RE.test(data.fabImage)) {
                const result = await storeBase64Image(data.fabImage);
                if (result) {
                    data.fabImage = result.url;
                    referenced.add(result.name);
                }
            }
        }
    } else {
        // outfit partition: 扫描 outfits 和 accessories 数组
        if (Array.isArray(data.outfits)) {
            for (const o of data.outfits) {
                if (!o || typeof o !== 'object') continue;
                const v = o.imageData;
                if (typeof v !== 'string' || !v) continue;

                if (v.startsWith(IMAGE_URL_PREFIX)) {
                    const name = path.basename(v);
                    if (isValidImageName(name)) referenced.add(name);
                    continue;
                }

                const result = await storeBase64Image(v);
                if (result) {
                    o.imageData = result.url;
                    referenced.add(result.name);
                }
            }
        }
        if (Array.isArray(data.accessories)) {
            for (const o of data.accessories) {
                if (!o || typeof o !== 'object') continue;
                const v = o.imageData;
                if (typeof v !== 'string' || !v) continue;

                if (v.startsWith(IMAGE_URL_PREFIX)) {
                    const name = path.basename(v);
                    if (isValidImageName(name)) referenced.add(name);
                    continue;
                }

                const result = await storeBase64Image(v);
                if (result) {
                    o.imageData = result.url;
                    referenced.add(result.name);
                }
            }
        }
    }
    return referenced;
}

// ── 图片分离：完整旧格式数据（/data PUT 兼容用）─────────
async function externalizeAllImages(data) {
    if (!data || typeof data !== 'object') return new Set();
    const referenced = new Set();

    const processOutfits = async (outfits) => {
        if (!Array.isArray(outfits)) return;
        for (const o of outfits) {
            if (!o || typeof o !== 'object') continue;
            const v = o.imageData;
            if (typeof v !== 'string' || !v) continue;

            if (v.startsWith(IMAGE_URL_PREFIX)) {
                const name = path.basename(v);
                if (isValidImageName(name)) referenced.add(name);
                continue;
            }

            const result = await storeBase64Image(v);
            if (result) {
                o.imageData = result.url;
                referenced.add(result.name);
            }
        }
    };

    // User outfits/accessories
    await processOutfits(data.outfits);
    await processOutfits(data.accessories);

    // Char outfits/accessories
    if (data.chars && typeof data.chars === 'object') {
        for (const k of Object.keys(data.chars)) {
            const c = data.chars[k];
            if (c) {
                await processOutfits(c.outfits);
                await processOutfits(c.accessories);
            }
        }
    }

    // Presets outfits/accessories
    if (Array.isArray(data.presets)) {
        for (const p of data.presets) {
            if (p) {
                await processOutfits(p.outfits);
                await processOutfits(p.accessories);
            }
        }
    }

    // fabImage
    if (typeof data.fabImage === 'string' && data.fabImage) {
        if (data.fabImage.startsWith(IMAGE_URL_PREFIX)) {
            const name = path.basename(data.fabImage);
            if (isValidImageName(name)) referenced.add(name);
        } else if (DATA_URL_RE.test(data.fabImage)) {
            const result = await storeBase64Image(data.fabImage);
            if (result) {
                data.fabImage = result.url;
                referenced.add(result.name);
            }
        }
    }

    return referenced;
}

// ── 旧数据 → 分包迁移 ──────────────────────────────────
// 从旧 outfits.json 拆成 meta.json + part_*.json
// 迁移成功后将旧文件 rename 为备份

async function migrateFromLegacy(legacyData) {
    const meta = {};
    meta.activePartitions = {};

    // ── 提取设置到 meta（不含 currentChar，后面单独处理）──
    const settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView',
    ];
    settingsKeys.forEach(function (k) {
        if (legacyData[k] !== undefined) meta[k] = legacyData[k];
    });

    // ── User 默认预设 ──
    const userDefault = {
        outfits: legacyData.outfits || [],
        categories: legacyData.categories || [],
        activeIds: Array.isArray(legacyData.activeIds) ? legacyData.activeIds : [],
        accessories: legacyData.accessories || [],
        accCategories: legacyData.accCategories || [],
    };
    await writePartFile('user:__default__', userDefault);

    // ── User 预设 ──
    meta.presets = [];
    meta.activePresetId = legacyData.activePresetId || null;
    if (Array.isArray(legacyData.presets)) {
        for (const p of legacyData.presets) {
            if (!p) continue;
            let pid = p.id || ('p_' + crypto.randomBytes(4).toString('hex'));
            // 安全校验 pid，如果不合法则生成新的
            const testKey = 'user:' + pid;
            if (!validatePartKey(testKey)) {
                pid = 'p_' + crypto.randomBytes(4).toString('hex');
            }
            const partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            const pPart = {
                outfits: p.outfits || [],
                categories: p.categories || [],
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: p.accCategories || [],
            };
            await writePartFile(partKey, pPart);
        }
    }

    // ── activePresetId 语义处理 ──
    // 如果有 activePresetId，顶层 User 数据是当前活跃预设的工作状态
    // 要覆盖到对应预设分包，而不是只写进 __default__
    let activeUserPartKey = 'user:__default__';
    if (meta.activePresetId) {
        for (const pi of meta.presets) {
            if (pi.id === meta.activePresetId) {
                activeUserPartKey = pi.partKey;
                // 用顶层数据覆盖活跃预设分包
                await writePartFile(pi.partKey, {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories,
                });
                break;
            }
        }
    }

    // User activePartitions
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPartKey] = userDefault.activeIds.slice();
    }

    // ── 角色 ──
    meta.charIndex = [];
    meta.charFavorites = [];
    meta.charGroups = {};

    const charNames = legacyData.charNames || [];
    // 收集 chars 里有但 charNames 没列的
    if (legacyData.chars) {
        for (const cn of Object.keys(legacyData.chars)) {
            if (cn !== '__shared__' && charNames.indexOf(cn) === -1) {
                charNames.push(cn);
            }
        }
    }

    // name → charId 映射（后续转换 currentChar/charFavorites/charGroups 用）
    const nameToId = {};

    // 通用衣柜
    if (legacyData.chars && legacyData.chars['__shared__']) {
        const scd = legacyData.chars['__shared__'];
        const sharedPart = {
            outfits: scd.outfits || [],
            categories: scd.categories || [],
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: scd.accCategories || [],
        };
        meta.charIndex.push({ id: '__shared__', name: '__shared__', partKey: 'char:__shared__' });
        await writePartFile('char:__shared__', sharedPart);
        if (sharedPart.activeIds.length > 0) {
            meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
        }
    }

    // 普通角色
    for (const name of charNames) {
        const cid = 'c_' + crypto.randomBytes(4).toString('hex').slice(0, 8);
        nameToId[name] = cid;
        const partKey = 'char:' + cid;
        const cd = (legacyData.chars && legacyData.chars[name]) || { outfits: [], categories: [], activeIds: [], accessories: [], accCategories: [] };
        const charPart = {
            outfits: cd.outfits || [],
            categories: cd.categories || [],
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: cd.accCategories || [],
        };
        meta.charIndex.push({ id: cid, name: name, partKey: partKey });
        await writePartFile(partKey, charPart);
        if (charPart.activeIds.length > 0) {
            meta.activePartitions[partKey] = charPart.activeIds.slice();
        }
    }

    // ── currentChar: 角色名 → charId ──
    if (legacyData.currentChar) {
        if (legacyData.currentChar === '__shared__') {
            meta.currentChar = '__shared__';
        } else {
            meta.currentChar = nameToId[legacyData.currentChar] || '';
        }
    } else {
        meta.currentChar = '';
    }

    // ── charFavorites: 角色名数组 → charId 数组 ──
    const oldFavs = legacyData.charFavorites || [];
    oldFavs.forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });

    // ── charGroups: { groupName: 角色名[] } → { groupName: charId[] } ──
    const oldGroups = legacyData.charGroups || {};
    for (const gn of Object.keys(oldGroups)) {
        meta.charGroups[gn] = [];
        (oldGroups[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    // ── 图片分离：处理所有刚写入的 partition ──
    // meta 的 fabImage
    await externalizePartitionImages('meta', meta);

    // 各 partition 的 outfits
    const allKeys = await listPartKeys();
    for (const key of allKeys) {
        if (key === 'meta') continue;
        const data = await readPartFile(key);
        if (data) {
            await externalizePartitionImages(key, data);
            await writePartFile(key, data);
        }
    }

    // ── 写 meta ──
    await writePartFile('meta', meta);

    // ── 备份旧文件 ──
    const now = new Date();
    const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '-'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    const backupName = 'outfits.v1-backup-' + ts + '.json';
    const backupPath = path.join(DATA_DIR, backupName);
    await fsp.rename(LEGACY_DATA_FILE, backupPath);

    console.log('[outfit-manager] v1→v2 迁移完成，旧文件已备份为 ' + backupName);
}

// ── 分包 → 旧格式重组（GET /data 兼容用）────────────────

async function reassembleFullData() {
    const meta = (await readPartFile('meta')) || {};
    const d = {};

    // 设置字段（不含 currentChar，后面单独转换）
    const settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView',
    ];
    settingsKeys.forEach(function (k) { if (meta[k] !== undefined) d[k] = meta[k]; });

    // ── currentChar: charId → 角色名 ──
    if (meta.currentChar && meta.currentChar === '__shared__') {
        d.currentChar = '__shared__';
    } else if (meta.currentChar && Array.isArray(meta.charIndex)) {
        let found = '';
        for (const ci of meta.charIndex) {
            if (ci.id === meta.currentChar) { found = ci.name; break; }
        }
        d.currentChar = found;
    } else {
        d.currentChar = meta.currentChar || '';
    }

    // ── User 数据：根据 activePresetId 决定从哪个分包读 ──
    let activeUserPartKey = 'user:__default__';
    if (meta.activePresetId && Array.isArray(meta.presets)) {
        for (const pi of meta.presets) {
            if (pi.id === meta.activePresetId) { activeUserPartKey = pi.partKey; break; }
        }
    }
    const activeUserPart = (await readPartFile(activeUserPartKey)) || {
        outfits: [],
        categories: [],
        activeIds: [],
        accessories: [],
        accCategories: [],
    };
    d.outfits = activeUserPart.outfits || [];
    d.categories = activeUserPart.categories || [];
    d.activeIds = activeUserPart.activeIds || [];
    d.accessories = activeUserPart.accessories || [];
    d.accCategories = activeUserPart.accCategories || [];

    // 预设
    d.presets = [];
    d.activePresetId = meta.activePresetId || null;
    if (Array.isArray(meta.presets)) {
        for (const pi of meta.presets) {
            const pp = (await readPartFile(pi.partKey)) || {
                outfits: [],
                categories: [],
                activeIds: [],
                accessories: [],
                accCategories: [],
            };
            d.presets.push({
                id: pi.id,
                name: pi.name,
                outfits: pp.outfits || [],
                categories: pp.categories || [],
                activeIds: pp.activeIds || [],
                accessories: pp.accessories || [],
                accCategories: pp.accCategories || [],
            });
        }
    }

    // ── 角色 ──
    d.chars = {};
    d.charNames = [];

    // charId → name 映射（转换 charFavorites/charGroups 用）
    const idToName = {};
    if (Array.isArray(meta.charIndex)) {
        for (const ci of meta.charIndex) {
            if (ci.id !== '__shared__') idToName[ci.id] = ci.name;
            const cp = (await readPartFile(ci.partKey)) || {
                outfits: [],
                categories: [],
                activeIds: [],
                accessories: [],
                accCategories: [],
            };
            if (ci.id === '__shared__') {
                d.chars['__shared__'] = {
                    outfits: cp.outfits || [],
                    categories: cp.categories || [],
                    activeIds: cp.activeIds || [],
                    accessories: cp.accessories || [],
                    accCategories: cp.accCategories || [],
                };
            } else {
                d.charNames.push(ci.name);
                d.chars[ci.name] = {
                    outfits: cp.outfits || [],
                    categories: cp.categories || [],
                    activeIds: cp.activeIds || [],
                    accessories: cp.accessories || [],
                    accCategories: cp.accCategories || [],
                };
            }
        }
    }

    // ── charFavorites: charId[] → 角色名[] ──
    d.charFavorites = [];
    if (Array.isArray(meta.charFavorites)) {
        meta.charFavorites.forEach(function (cid) {
            if (idToName[cid]) d.charFavorites.push(idToName[cid]);
        });
    }

    // ── charGroups: { group: charId[] } → { group: 角色名[] } ──
    d.charGroups = {};
    if (meta.charGroups && typeof meta.charGroups === 'object') {
        for (const gn of Object.keys(meta.charGroups)) {
            d.charGroups[gn] = [];
            (meta.charGroups[gn] || []).forEach(function (cid) {
                if (idToName[cid]) d.charGroups[gn].push(idToName[cid]);
            });
        }
    }

    return d;
}

// ── 旧格式 → 分包拆解（PUT /data 兼容用）────────────────

async function splitFullDataToPartitions(data) {
    // 图片分离（沿用旧的全量处理）
    await externalizeAllImages(data);

    const meta = {};
    meta.activePartitions = {};

    // 设置（不含 currentChar，后面单独转换）
    const settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'tagOrder',
        'currentView',
    ];
    settingsKeys.forEach(function (k) { if (data[k] !== undefined) meta[k] = data[k]; });

    // User 默认预设
    const userDefault = {
        outfits: data.outfits || [],
        categories: data.categories || [],
        activeIds: Array.isArray(data.activeIds) ? data.activeIds : [],
        accessories: data.accessories || [],
        accCategories: data.accCategories || [],
    };
    await writePartFile('user:__default__', userDefault);

    // 预设
    meta.presets = [];
    meta.activePresetId = data.activePresetId || null;
    if (Array.isArray(data.presets)) {
        for (const p of data.presets) {
            if (!p) continue;
            let pid = p.id || ('p_' + crypto.randomBytes(4).toString('hex'));
            const testKey = 'user:' + pid;
            if (!validatePartKey(testKey)) {
                pid = 'p_' + crypto.randomBytes(4).toString('hex');
            }
            const partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            await writePartFile(partKey, {
                outfits: p.outfits || [],
                categories: p.categories || [],
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: p.accCategories || [],
            });
        }
    }

    // ── activePresetId 语义：顶层 User 数据覆盖到活跃预设分包 ──
    let activeUserPartKey = 'user:__default__';
    if (meta.activePresetId) {
        for (const pi of meta.presets) {
            if (pi.id === meta.activePresetId) {
                activeUserPartKey = pi.partKey;
                await writePartFile(pi.partKey, {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories,
                });
                break;
            }
        }
    }

    // User activePartitions
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPartKey] = userDefault.activeIds.slice();
    }

    // ── 角色 — 读取现有 meta 来保留已有的 charId 映射 ──
    const existingMeta = (await readPartFile('meta')) || {};
    const existingCharIndex = existingMeta.charIndex || [];
    const nameToExisting = {};
    existingCharIndex.forEach(function (ci) { nameToExisting[ci.name] = ci; });

    meta.charIndex = [];
    meta.charFavorites = [];
    meta.charGroups = {};

    // name → charId 映射（转换用）
    const nameToId = {};

    const charNames = data.charNames || [];
    if (data.chars) {
        for (const cn of Object.keys(data.chars)) {
            if (cn !== '__shared__' && charNames.indexOf(cn) === -1) charNames.push(cn);
        }
    }

    // 通用衣柜
    if (data.chars && data.chars['__shared__']) {
        const scd = data.chars['__shared__'];
        const sharedPart = {
            outfits: scd.outfits || [],
            categories: scd.categories || [],
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: scd.accCategories || [],
        };
        meta.charIndex.push({ id: '__shared__', name: '__shared__', partKey: 'char:__shared__' });
        await writePartFile('char:__shared__', sharedPart);
        if (sharedPart.activeIds.length > 0) {
            meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
        }
    }

    // 普通角色
    for (const name of charNames) {
        // 优先复用已有的 charId
        let ci = nameToExisting[name];
        if (!ci) {
            const cid = 'c_' + crypto.randomBytes(4).toString('hex').slice(0, 8);
            ci = { id: cid, name: name, partKey: 'char:' + cid };
        }
        nameToId[name] = ci.id;
        meta.charIndex.push(ci);
        const cd = (data.chars && data.chars[name]) || { outfits: [], categories: [], activeIds: [], accessories: [], accCategories: [] };
        const charPart = {
            outfits: cd.outfits || [],
            categories: cd.categories || [],
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: cd.accCategories || [],
        };
        await writePartFile(ci.partKey, charPart);
        if (charPart.activeIds.length > 0) {
            meta.activePartitions[ci.partKey] = charPart.activeIds.slice();
        }
    }

    // ── currentChar: 角色名 → charId ──
    if (data.currentChar) {
        if (data.currentChar === '__shared__') {
            meta.currentChar = '__shared__';
        } else {
            meta.currentChar = nameToId[data.currentChar] || '';
        }
    } else {
        meta.currentChar = '';
    }

    // ── charFavorites: 角色名[] → charId[] ──
    (data.charFavorites || []).forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });

    // ── charGroups: { group: 角色名[] } → { group: charId[] } ──
    const oldGroups = data.charGroups || {};
    for (const gn of Object.keys(oldGroups)) {
        meta.charGroups[gn] = [];
        (oldGroups[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    // 清理不再存在的角色分包
    for (const oldCi of existingCharIndex) {
        if (oldCi.id === '__shared__') continue;
        const stillExists = meta.charIndex.some(function (ci) { return ci.id === oldCi.id; });
        if (!stillExists) {
            await deletePartFile(oldCi.partKey);
        }
    }

    // 清理不再存在的预设分包
    const existingPresets = existingMeta.presets || [];
    for (const oldP of existingPresets) {
        const stillExists = meta.presets.some(function (p) { return p.id === oldP.id; });
        if (!stillExists) {
            await deletePartFile(oldP.partKey);
        }
    }

    // 写 meta
    await writePartFile('meta', meta);
}

// ── GC：扫描所有分包收集引用 → 删除未引用图片 ──────────

async function collectAllReferences() {
    const referenced = new Set();

    const collectFromOutfits = (outfits) => {
        if (!Array.isArray(outfits)) return;
        for (const o of outfits) {
            if (!o || typeof o.imageData !== 'string') continue;
            if (o.imageData.startsWith(IMAGE_URL_PREFIX)) {
                const name = path.basename(o.imageData);
                if (isValidImageName(name)) referenced.add(name);
            }
        }
    };

    // 读取所有 partition key
    const keys = await listPartKeys();
    for (const key of keys) {
        const data = await readPartFile(key);
        if (!data) continue;

        if (key === 'meta') {
            // fabImage
            if (typeof data.fabImage === 'string' && data.fabImage.startsWith(IMAGE_URL_PREFIX)) {
                const name = path.basename(data.fabImage);
                if (isValidImageName(name)) referenced.add(name);
            }
        } else {
            // outfit partition
            collectFromOutfits(data.outfits);
            collectFromOutfits(data.accessories);
        }
    }

    return referenced;
}

async function gcImages(dryRun) {
    const referenced = await collectAllReferences();

    let files;
    try {
        files = await fsp.readdir(IMAGES_DIR);
    } catch (err) {
        if (err && err.code === 'ENOENT') return { removed: 0, kept: 0, candidates: [] };
        throw err;
    }

    const candidates = [];
    for (const f of files) {
        if (!isValidImageName(f)) continue;
        if (!referenced.has(f)) candidates.push(f);
    }

    if (!dryRun) {
        for (const f of candidates) {
            try { await fsp.unlink(path.join(IMAGES_DIR, f)); } catch { /* ignore */ }
        }
    }

    return {
        removed: dryRun ? 0 : candidates.length,
        kept: referenced.size,
        candidates: dryRun ? candidates : [],
        wouldRemove: dryRun ? candidates.length : undefined,
    };
}

// ── 启动时迁移检测 ──────────────────────────────────────

async function checkAndMigrate() {
    // 如果已有 meta.json，说明已是 v2 分包格式
    try {
        await fsp.access(META_FILE);
        return; // 已迁移
    } catch { /* no meta.json, continue */ }

    // 检查旧 outfits.json
    let legacyData;
    try {
        legacyData = await readLegacyFile();
    } catch { /* ignore */ }

    if (legacyData && typeof legacyData === 'object') {
        // 有旧数据，执行迁移
        console.log('[outfit-manager] 检测到旧 outfits.json，开始 v1→v2 迁移...');
        await migrateFromLegacy(legacyData);
    }
    // 无旧数据也无 meta = 全新安装，无需处理
}

// ── 路由初始化 ──────────────────────────────────────────
async function init(router) {
    // 路由必须同步注册（ST server plugin 要求）
    router.use(express.json({ limit: '64mb' }));

    // ─ GET /status ──────────────────────────────────────
    router.get('/status', (_req, res) => {
        res.json({ ok: true, version: 2, partitions: true, name: info.name });
    });

    // ─ GET /data（兼容：从分包重组）─────────────────────
    router.get('/data', async (_req, res) => {
        try {
            // 优先从分包重组
            const hasMeta = await readPartFile('meta');
            if (hasMeta) {
                const data = await reassembleFullData();
                res.json({ ok: true, data: data });
                return;
            }
            // 降级：读旧文件（理论上 checkAndMigrate 已处理，但以防万一）
            const legacy = await readLegacyFile();
            res.json({ ok: true, data: legacy || null });
        } catch (err) {
            console.error('[outfit-manager] GET /data failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to read data' });
        }
    });

    // ─ PUT /data（兼容：拆成分包写入）───────────────────
    router.put('/data', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
            }
            await splitFullDataToPartitions(body);
            res.json({ ok: true });
        } catch (err) {
            console.error('[outfit-manager] PUT /data failed:', err.message);
            if (err.message && err.message.includes('PayloadTooLargeError')) {
                res.status(413).json({ ok: false, error: '数据过大，请尝试分批迁移或先清理后重试' });
            } else {
                res.status(500).json({ ok: false, error: 'Failed to write data' });
            }
        }
    });

    // ─ GET /partitions/keys（必须在 /:key 前注册）───────
    router.get('/partitions/keys', async (_req, res) => {
        try {
            const keys = await listPartKeys();
            res.json({ ok: true, keys: keys });
        } catch (err) {
            console.error('[outfit-manager] GET /partitions/keys failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to list partition keys' });
        }
    });

    // ─ GET /partitions/:key ─────────────────────────────
    router.get('/partitions/:key', async (req, res) => {
        try {
            const key = req.params.key;
            if (!validatePartKey(key)) {
                return res.status(400).json({ ok: false, error: 'Invalid partition key' });
            }
            const data = await readPartFile(key);
            res.json({ ok: true, data: data || null });
        } catch (err) {
            console.error('[outfit-manager] GET /partitions/:key failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to read partition' });
        }
    });

    // ─ PUT /partitions/:key ─────────────────────────────
    router.put('/partitions/:key', async (req, res) => {
        try {
            const key = req.params.key;
            if (!validatePartKey(key)) {
                return res.status(400).json({ ok: false, error: 'Invalid partition key' });
            }
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
            }
            // 图片分离
            await externalizePartitionImages(key, body);
            await writePartFile(key, body);
            res.json({ ok: true });
        } catch (err) {
            console.error('[outfit-manager] PUT /partitions/:key failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to write partition' });
        }
    });

    // ─ DELETE /partitions/:key ──────────────────────────
    router.delete('/partitions/:key', async (req, res) => {
        try {
            const key = req.params.key;
            if (!validatePartKey(key)) {
                return res.status(400).json({ ok: false, error: 'Invalid partition key' });
            }
            // 不允许删除 meta
            if (key === 'meta') {
                return res.status(400).json({ ok: false, error: 'Cannot delete meta partition' });
            }
            await deletePartFile(key);
            res.json({ ok: true });
        } catch (err) {
            console.error('[outfit-manager] DELETE /partitions/:key failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to delete partition' });
        }
    });

    // ─ POST /images ─────────────────────────────────────
    // 单张上传：body = { dataUrl: "data:image/..." }
    router.post('/images', async (req, res) => {
        try {
            const { dataUrl } = req.body || {};
            if (typeof dataUrl !== 'string' || !dataUrl) {
                return res.status(400).json({ ok: false, error: 'Missing dataUrl field' });
            }
            const result = await storeBase64Image(dataUrl);
            if (!result) {
                return res.status(400).json({ ok: false, error: 'Invalid image format. Allowed: jpg/png/webp/gif/bmp' });
            }
            res.json({ ok: true, name: result.name, url: result.url });
        } catch (err) {
            console.error('[outfit-manager] POST /images failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to store image' });
        }
    });

    // ─ POST /images/batch-fetch ─────────────────────────
    router.post('/images/batch-fetch', async (req, res) => {
        try {
            const { urls } = req.body || {};
            if (!Array.isArray(urls)) {
                return res.status(400).json({ ok: false, error: 'urls must be an array' });
            }

            const results = {};
            for (const url of urls) {
                if (typeof url !== 'string') continue;
                if (!url.startsWith(IMAGE_URL_PREFIX)) continue;
                const name = path.basename(url);
                if (!isValidImageName(name)) continue;
                if (results[url]) continue;

                const dataUrl = await imageToDataUrl(name);
                if (dataUrl) {
                    results[url] = dataUrl;
                }
            }
            res.json({ ok: true, images: results });
        } catch (err) {
            console.error('[outfit-manager] POST /images/batch-fetch failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to fetch images' });
        }
    });

    // ─ GET /images/:name ────────────────────────────────
    router.get('/images/:name', (req, res) => {
        const name = path.basename(req.params.name || '');
        if (!isValidImageName(name)) {
            return res.status(400).json({ ok: false, error: 'Invalid image name' });
        }
        const filePath = path.join(IMAGES_DIR, name);
        if (!filePath.startsWith(IMAGES_DIR + path.sep)) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        res.sendFile(filePath, (err) => {
            if (err) {
                if (err.code === 'ENOENT') res.status(404).json({ ok: false, error: 'Not found' });
                else { try { res.status(500).end(); } catch { /* noop */ } }
            }
        });
    });

    // ─ POST /gc ─────────────────────────────────────────
    router.post('/gc', async (req, res) => {
        try {
            const dryRun = !!(req.body && req.body.dryRun);
            const result = await gcImages(dryRun);
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[outfit-manager] POST /gc failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to gc' });
        }
    });

    // 全局错误处理
    router.use(function (err, _req, res, _next) {
        if (err.type === 'entity.too.large') {
            console.error('[outfit-manager] Request too large:', err.message);
            res.status(413).json({
                ok: false,
                error: '数据过大，请先导出备份/分批迁移/清理图片后重试',
            });
        } else {
            console.error('[outfit-manager] Unexpected error:', err.message);
            res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    // 路由注册完毕，执行异步初始化
    ensureDirsSync();
    await checkAndMigrate();
    console.log('[outfit-manager] Plugin loaded (v2 partition storage). Data dir: ' + DATA_DIR);
}

async function exit() {
    // 无需特殊清理
}

module.exports = { init, exit, info };
