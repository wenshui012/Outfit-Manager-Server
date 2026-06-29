# 穿搭管理器 · 后端同步方案 v2.0.0

## 目标（第一阶段）
- 开启后端后，日常使用无感
- 导出仍是完整备份（带图片）
- 换环境导入不丢图
- 后端不可用自动回本地
- 支持 2.0 单品数据：`accessories`、`accCategories` 和单品图片

## 文件清单

### 后端（ST server plugin）
```
plugins/outfit-manager/
  ├── package.json          # 插件元数据
  └── index.js              # 7个API端点
```

放在 ST 根目录的 `plugins/` 下，需开启 `enableServerPlugins`。

### 前端改动

#### 1. db.js — 存储层重构（替换原文件）
- 新增 server adapter（探测、GET/PUT、队列合并）
- 新增 `resolveImageForExternal()` — 后端 URL → base64 统一入口
- 新增 `batchResolveImages()` — 批量版本（导出用）
- 新增 `uploadImage()` — 单张上传到后端
- 新增 `initStorage()` — 启动初始化（含首次迁移）
- 新增 `isServerMode()` — 查询当前模式

#### 2. ui-batch.js — 导入导出改造（修改原文件）
详见 EXPORT-IMPORT-PATCH.js：
- `doExport`: server 模式下附加 `_assets` 映射表
- `processImport`: 导入前处理 `_assets`（上传或还原）
- `importData`: 文件读取后先 resolveImportAssets 再 processImport

#### 3. inject.js — 注入层适配（修改原文件）
详见 INJECT-PATCH.js：
- 图片注入时使用预解析缓存，不直接发后端 URL 给 AI
- `state.resolvedImages` 存储预解析结果

#### 4. 其他小改动
- `bridge.js`: state 添加 `resolvedImages: {}`
- `ui-sheets.js`: 存储信息显示 "服务器存储" / "IndexedDB 存储"
- `api.js`: Vision 调用前 resolve 图片 URL
- 入口文件: 用 `initStorage(cb)` 替代原来的 `loadFromDB(cb)` + `detectServer`

## API 端点汇总

| 方法   | 路径                    | 用途                  |
|--------|-------------------------|-----------------------|
| GET    | /status                 | 健康探测              |
| GET    | /data                   | 读取完整元数据        |
| PUT    | /data                   | 写入完整元数据        |
| POST   | /images                 | 单张图片上传          |
| POST   | /images/batch-fetch     | 批量取图片 base64     |
| GET    | /images/:name           | 读取单张图片          |
| POST   | /gc                     | 清理未引用图片        |

## _assets 导出格式
```json
{
  "outfits": [
    { "id": "xxx", "imageData": "/api/plugins/outfit-manager/images/sha1.jpg", ... }
  ],
  "_assets": {
    "sha1.jpg": "data:image/jpeg;base64,/9j/4AAQ..."
  }
}
```

同一张图被多个 outfit 引用时，_assets 中只存一份。
导入时：
- 后端可用 → 上传 _assets → 替换引用为新 URL
- 后端不可用 → 用 _assets base64 直接替换 URL 引用

## 安全设计
- 图片只允许 jpg/png/webp/gif/bmp，禁止 SVG
- batch-fetch 只接受本插件路径，不做开放代理
- 路径穿越双重防护（basename + startsWith）
- SHA1 内容寻址，同图去重
- 写文件 tmp → rename 原子操作
- CSRF token 兼容（优先 getRequestHeaders，回退手动获取）

## v2 预留
- `_rev` 乐观锁（多标签页冲突检测）
- `/gc` dry-run UI 集成到设置面板
- 图片懒加载（按角色加载）
- 增量同步（diff patch 代替全量 PUT）
