# Long Novel GPT — 重构方案 v3.0

## 决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 平台 | Electron 桌面应用，客户端直连 AI API |
| 2 | 文件格式 | 仅 TXT 导入/导出 |
| 3 | 语言 | TypeScript strict 模式 |
| 4 | UI 框架 | React + Vite + Tailwind CSS + Zustand |
| 5 | 角色追踪 | 全自动解析，追踪所有主要角色 |
| 6 | 场景补充 | 手动框选文本 + JSON 模板导入 |
| 7 | 模型策略 | 高级/低级双模型，用户分别配置 |
| 8 | 提示词 | 三层合一 JSON 文件（破甲词 + 识别规则 + 改写规则）|
| 9 | JSON 容错 | npm `jsonrepair` 覆盖所有 AI 响应解析 |

---

## 一、诊断：当前版本三大根因

| 问题 | 症状 | 根因 | 解决方案 |
|------|------|------|---------|
| OOC | 第二章改写不认第一章 | 无项目级上下文共享 | 新增 ProjectContext 层，章节间传递所有主要角色状态 |
| 识别失效 | 第二步初扫不出来，第三步重扫才出 | 状态初始化竞态 / 缓存未清除 | 引入状态机显式管理，每次进入阶段冷启动 |
| 卡顿 | 启动慢、交互迟滞 | 单文件 27534 行无模块化 + SQLite 同步阻塞主线程 + 列表无虚拟化 | 模块化拆分 + Worker 线程 DB + react-window |

---

## 二、总体架构

### 进程模型

```
┌─────────────────────────────────────────────────────┐
│  主进程 (Main Process)                               │
│                                                     │
│  ┌──────────────┐ ┌────────────────┐ ┌───────────┐  │
│  │ DB Service   │ │ AI Stream Srv  │ │File Srv   │  │
│  │ (Worker线程) │ │ (可取消/重试)  │ │(编码检测) │  │
│  └──────────────┘ └────────────────┘ └───────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ ProjectContext 引擎 (新增)                    │   │
│  │  - 人物状态追踪 (CharacterState)              │   │
│  │  - 前文章节摘要链 (SummaryChain)              │   │
│  │  - 全文角色发现 (CharacterDiscovery)          │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ ChapterTaskScheduler (新增)                    │   │
│  │  - 并发任务队列                                 │   │
│  │  - 用户可配置并发数                             │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  IPC: 4 命名空间, ~18 通道                           │
└────────────────────┬────────────────────────────────┘
                     │ contextBridge
┌────────────────────┴────────────────────────────────┐
│  预加载脚本                                          │
│                                                     │
│  window.electronAPI = {                             │
│    db,        // CRUD via Worker                    │
│    ai,        // stream + abort + JSON repair       │
│    fs,        // file ops                           │
│    context,   // 项目上下文查询 (新增)               │
│    settings   // 应用设置                           │
│  }                                                  │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────┐
│  渲染进程 (React SPA — 模块化, 单文件 ≤ 400 行)      │
│                                                     │
│  src/                                               │
│  ├── main.tsx                                       │
│  ├── App.tsx                                        │
│  ├── stores/               # Zustand                │
│  │   ├── useAppStore.ts                             │
│  │   ├── useProjectStore.ts                         │
│  │   ├── useBatchStore.ts                           │
│  │   └── useContextStore.ts  (新增)                  │
│  ├── pages/                                         │
│  │   ├── WorkbenchPage.tsx                          │
│  │   ├── ProjectPage.tsx                            │
│  │   ├── ModelsPage.tsx                             │
│  │   ├── TemplatesPage.tsx                          │
│  │   └── SettingsPage.tsx                           │
│  ├── components/                                    │
│  │   ├── layout/           # GlobalNav, Sidebar    │
│  │   ├── stepper/          # 阶段导航               │
│  │   ├── stages/                                    │
│  │   │   ├── split/                                │
│  │   │   ├── summary/                              │
│  │   │   ├── scan/                                 │
│  │   │   ├── rewrite/                              │
│  │   │   ├── preview/                              │
│  │   │   └── export/                               │
│  │   ├── workbench/         # 三栏布局 (新增)      │
│  │   │   ├── ChapterList.tsx                        │
│  │   │   ├── MainStage.tsx                         │
│  │   │   ├── SceneMarkers.tsx                       │
│  │   │   └── StatsPanel.tsx                        │
│  │   ├── shared/                                    │
│  │   └── ui/                                       │
│  ├── hooks/                                         │
│  ├── lib/                  # utils, repairJson 等  │
│  └── workers/              # Web Workers           │
└─────────────────────────────────────────────────────┘
```

### 6 阶段流水线

```
split → summary → scan → rewrite → preview → export
 (分章)  (可选)   (识别)  (改写)    (预览)    (导出)
```

其中 `summary` 阶段改为可选的手动触发（首次导入后快速了解全书内容）。真正的摘要产出发生在每章改写完成后，紧随改写自动生成。

---

## 三、核心改进

### 改进 1：项目级上下文引擎 — 解决 OOC

#### 改写完成后的处理链

每次章节改写完成后，执行 3 次 AI 调用：

```
改写完成 (高级模型)
  │  输出: { rewritten_text, character_updates[] }
  │  解析: jsonrepair → JSON.parse → safeParseAIJson
  │
  ├─ 1. 保存改写正文
  │
  ├─ 2. 增量更新角色状态 (character_state 表)
  │
  ├─ 3. 生成章节摘要 (低级模型)
  │     输入: 改写后文本 + 原文
  │     输出: { plot_summary, additions[] }
  │     → 存入 chapter_summaries
  │
  └─ 4. 全文角色发现 (低级模型)
        输入: 前 N 章改写后正文
        输出: [{ name, description, state_snapshot }]
        → diff 更新 character_state (新角色创建, 已有角色更新)
```

#### 改写前上下文注入

```
改写第 N 章时:
1. 查询 character_state WHERE project_id = X
   → 所有主要角色最新状态
2. 查询 chapter_summaries WHERE project_id = X AND chapter_index < N
   → 前 N-1 章摘要列表 (含剧情概括 + 增扩标注)
3. 合并注入改写 Prompt:
   ---
   [角色当前状态]
   张三: 穿着黑色风衣，左臂受伤，情绪愤怒，位置在码头仓库
   ...
   
   [前文章节摘要]
   第1章: ... [已扩写: 环境细节、心理活动]
   第2章: ... [已扩写: 争吵场景、表情细节]
   ...
   ---
```

#### Prompt 占位符

```
{{characterStates}}       → 所有主要角色当前状态
{{chapterSummaries}}      → 前 N-1 章摘要列表 (含增扩标注)
{{manualScenes}}          → 手动标记场景的文本片段
```

#### Token 预算管理

```
if (前文摘要总 token 数 > 上下文预算的 30%) {
  对 N-4 及更早的章节，用"事件列表"替代全文摘要
  最近 3 章完整摘要始终保留
}
上下文预算 = 模型 max_tokens 的 40%，剩余 60% 留给正文和输出。
```

#### 角色状态自动解析

改写 Prompt 要求 AI 输出结构化 JSON：

```json
{
  "rewritten_text": "...",
  "character_updates": [
    {
      "name": "张三",
      "state_snapshot": {
        "appearance": "穿着染血的黑色风衣",
        "emotion": "愤怒中带着疲惫",
        "location": "码头仓库二楼",
        "status": "左臂受伤，行动受限",
        "relationships": { "李四": "确认背叛，决心复仇" }
      }
    }
  ]
}
```

解析流程: jsonrepair → JSON.parse。失败容错: 重试一次, 仍失败则跳过角色更新, 只保存正文, 不阻塞流程。

#### 章节摘要结构

```
## 第3章 摘要

### 剧情概括
张三潜入码头仓库寻找证据，发现了一份秘密货运清单，
确认李四参与了走私活动...

### 改写增扩标注
- 新增：仓库内部环境细节描写（生锈集装箱、柴油味、昏暗灯光）
- 扩展：张三与保安的对峙场景，原文一句带过，改写为完整追逐段落
- 保留：核心情节走向与原作一致
```

#### 人工兜底

- 角色状态手动编辑: 设置页查看/编辑/锁定/删除角色
- 摘要手动编辑: 章节导航中展开编辑面板
- 锁定机制: 手动修改过的字段标记 locked, AI 不再覆盖

---

### 改进 2：AI 通信层

#### 2.1 流式通信

```typescript
class AIStreamService {
  private activeStreams = new Map<string, AbortController>();

  async startStream(request: AIRequest): Promise<void> {
    const controller = new AbortController();
    this.activeStreams.set(request.id, controller);

    const response = await fetch(url, {
      signal: controller.signal,
      body: JSON.stringify({ stream: true, ...request })
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const tokens = this.parseSSE(chunk);
      for (const token of tokens) {
        mainWindow.webContents.send('ai:token', { id: request.id, token });
      }
    }
    mainWindow.webContents.send('ai:done', { id: request.id });
  }

  abort(id: string) {
    this.activeStreams.get(id)?.abort();
  }
}
```

每个流请求有唯一 ID，AbortController 绑定支持取消。主进程做 SSE 解析处理断包，渲染进程只收单条完整 token。

#### 流式中断处理

| 场景 | 处理 |
|------|------|
| 轻微网络抖动 (socket 超时) | 3s 后重试完整请求，覆盖前一次结果 |
| 长时间中断或服务端错误 | 标记该段落为 failed, 用户手动重试 |
| AI API 不支持 HTTP 断点续传 | 不做魔法重连，实事求是 |

#### 2.2 JSON Repair

所有 AI 响应解析前统一用 `jsonrepair` 修复。

```bash
pnpm add jsonrepair
```

```typescript
import { jsonrepair } from 'jsonrepair';

function safeParseAIJson(raw: string): { data: unknown } | { error: string } {
  const jsonBlock = extractJsonBlock(raw);
  try {
    const repaired = jsonrepair(jsonBlock);
    return { data: JSON.parse(repaired) };
  } catch (e) {
    return { error: `JSON parse failed after repair: ${(e as Error).message}` };
  }
}

function extractJsonBlock(s: string): string {
  // 优先提取 ```json ... ``` markdown 代码块
  const mdMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) return mdMatch[1].trim();
  // 从第一个 { 或 [ 开始截取
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  const start = firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket);
  if (start === -1) return s;
  return s.slice(start);
}
```

覆盖所有 AI 响应: 改写/摘要/角色发现/场景识别。jsonrepair 自动处理: trailing commas, 单引号→双引号, 未加引号 key, 未转义换行符, 不完整结构, JSON5/JSONC 兼容。

#### 2.3 批量并发控制

用户可配置同时处理几章 (默认 3, 建议 2-5)。

```typescript
class ChapterTaskScheduler {
  private queue: ChapterTask[] = [];
  private running = new Map<string, AbortController>();
  private maxConcurrency = 3;

  setConcurrency(n: number) { this.maxConcurrency = n; this.drain(); }

  enqueue(task: ChapterTask) { this.queue.push(task); this.drain(); }

  private drain() {
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.execute(task);
    }
  }

  private async execute(task: ChapterTask) {
    const controller = new AbortController();
    this.running.set(task.chapterId, controller);
    emitUpdate(task.chapterId, 'processing');
    try {
      await runStage(task, controller.signal);
      emitUpdate(task.chapterId, 'done');
    } catch (e) {
      emitUpdate(task.chapterId, 'error', e.message);
    } finally {
      this.running.delete(task.chapterId);
      this.drain();
    }
  }

  cancel(chapterId: string) { this.running.get(chapterId)?.abort(); }
  cancelAll() { this.running.forEach(c => c.abort()); this.queue = []; }
}
```

---

### 改进 3：性能优化

| 瓶颈 | 当前状况 | 改进措施 |
|------|---------|---------|
| 渲染进程体积 | 单文件 27534 行 | 模块化拆分，单文件 ≤ 400 行 |
| 章节列表渲染 | 全文一次性 DOM | react-window 虚拟滚动 |
| 段落渲染 | 数千段落直接渲染 | 段落虚拟化，懒加载 |
| SQLite 操作 | 同步阻塞主线程 | Worker 线程执行 |
| 文件读取 | 同步读大 TXT | Worker 异步 + 进度回调 |
| 首屏加载 | 加载全部数据 | 按需分页，首屏只加载项目列表 |

```typescript
// db.worker.ts
import { parentPort } from 'worker_threads';
import Database from 'better-sqlite3';

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

parentPort.on('message', ({ id, method, args }) => {
  try {
    const result = db[method](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
```

```tsx
// 虚拟化章节列表
import { FixedSizeList } from 'react-window';

<FixedSizeList height={containerHeight} itemCount={chapters.length} itemSize={48} width={220}>
  {({ index, style }) => (
    <ChapterItem key={chapters[index].id} chapter={chapters[index]} style={style} />
  )}
</FixedSizeList>
```

---

## 四、工作台交互设计

### 三栏布局

```
┌──────────────────────────────────────────────────────────┐
│  [返回项目]  第3章 / 共24章   [Scan 阶段]  [批量开始]     │  ← 工具栏
├────────────┬─────────────────────────────┬───────────────┤
│ 左侧 260px │      中间主操作区            │  右侧 240px   │
│            │                             │               │
│ ✅ 第1章   │  ┌── 原文 ────────────────┐ │  已完成: 2    │
│   环境描写 │  │ 夜幕降临，张三走进码头  │ │  进行中: 1    │
│            │  │ 的旧仓库...             │ │  未处理: 21   │
│ 🔄 第2章   │  │ ░░░░░░ AI识别: 环境描写 │ │  失败: 0      │
│   ▓▓▓▓ 67% │  │ ░░░░░░ 手动标记场景    │ │               │
│   进行中   │  └────────────────────────┘ │  进度: 8.3%   │
│            │                             │               │
│ ⏳ 第3章   │  ┌── AI 识别结果 ─────────┐ │ [全部开始]    │
│            │  │ ✓ 环境描写 (0.92)       │ │ [全部停止]    │
│ ⏳ 第4章   │  │ ✓ 心魔纠缠 (0.88)       │ │ [重试全部失败] │
│            │  │ 🖊 手动标记 ×1          │ └───────────────┘
│ ❌ 第5章   │  └────────────────────────┘ │
│   timeout  │                             │
│  [重试]    │  [确认场景] [重新识别]      │
│            │                             │
├────────────┴─────────────────────────────┴───────────────┤
│  状态栏: 24章 · 场景规则: 女魔头心魔 · 高级模型: Opus     │
└──────────────────────────────────────────────────────────┘
```

### 左侧章节状态联动

```typescript
type ChapterStatus = 'pending' | 'processing' | 'done' | 'error';

const statusVisual: Record<ChapterStatus, {
  icon: string; titleColor: string; bg: string
}> = {
  pending:    { icon: '⏳', titleColor: '#9ca3af', bg: 'transparent' },
  processing: { icon: '🔄', titleColor: '#22c55e', bg: '#22c55e10' },
  done:       { icon: '✅', titleColor: '#16a34a', bg: '#16a34a08' },
  error:      { icon: '❌', titleColor: '#ef4444', bg: '#ef444408' },
};
```

```
✅ 第1章  码头夜话  ●          ← 绿色标题 + 黄色圆点 (有待扩写场景)
   环境描写 · 心魔纠缠          ← 识别到的场景名

🔄 第2章  仓库对峙              ← 绿色标题 + 脉冲动画
   ▓▓▓▓▓▓░░░░ 67%              ← 进度条

❌ 第5章  雨夜追踪              ← 红色标题
   Error: timeout              ← 错误信息
   [点击重试]
```

### 右侧统计面板

```
┌─────────────────────┐
│  已完成     ██ 2     │
│  进行中     ░░ 1     │
│  未处理     ░░ 21    │
│  失败       ░░ 0     │
│  ────────────────   │
│  总计: 24 章         │
│  进度: 8.3%          │
│                     │
│  [全部开始]          │
│  [全部停止]          │
│  [重试全部失败]       │
└─────────────────────┘
```

### 场景识别交互 (Scan 阶段)

#### 原文中的场景标记

```
┌─ 原文 第1章 ──────────────────────────────────────────┐
│                                                        │
│  夜幕降临，张三走进码头的旧仓库。                         │
│ ┌────────────────────────────────────────┐             │
│ │ 仓库里堆满生锈的集装箱，空气中弥漫着    │ 淡蓝色虚线   │
│ │ 柴油和铁锈的味道。他握紧了口袋里的枪。  │ AI识别      │
│ └────────────────────────────────────────┘             │
│   环境描写 (AI · 0.92)                                 │
│                                                        │
│ ┌──────────────────────┐                                │
│ │ 他的心跳加速，手心的   │ 淡紫色虚线                    │
│ │ 汗浸湿了枪柄。        │ 手动标记                      │
│ └──────────────────────┘                                │
│   手动标记场景                                          │
└────────────────────────────────────────────────────────┘
```

- AI 识别: 淡蓝色虚线边框 + 场景名标签
- 手动标记: 用户拖选 → 浮动工具栏[标记为场景] → 淡紫色虚线边框
- 重叠区间自动合并

#### AI 识别结果面板

```
┌─ AI 识别结果 ──────────────────────────────┐
│ ✓ 环境描写 (0.92)    [预览] [忽略]          │
│ ✓ 心魔纠缠 (0.88)    [预览] [忽略]          │
│ 🖊 手动标记 ×1        [预览] [移除]          │
│ ──────────────────────────────              │
│ [确认全部场景] [重新识别本章]                 │
└─────────────────────────────────────────────┘
```

操作: 确认/忽略/调整/重新识别。确认后进入 Rewrite 阶段。

#### 数据存储

```sql
ALTER TABLE paragraphs ADD COLUMN scene_tags TEXT;
-- [{
--   "category_id": "cat_heart_demon",
--   "name": "心魔纠缠",
--   "start": 120, "end": 145,
--   "source": "ai" | "manual",
--   "confidence": 0.88
-- }]
```

---

## 五、提示词模板 JSON 格式

一个 JSON 文件包含完整三层: 破甲词 + 识别规则 + 改写规则。

```json
{
  "name": "《女魔头心魔》加料模板",
  "version": "1.0",
  "description": "古风仙侠，19个场景分类",

  "breakthroughTemplate": "【系统破甲】\n1. 指令神圣: ...\n2. 角色剥离: ...",

  "identifyTemplate": {
    "categories": [
      {
        "id": "cat_heart_demon",
        "name": "心魔纠缠场景",
        "conditions": "识别点：陈墨与玉幽寒的心魔互动。\n关键词：心魔、红绫、梦境、束缚、幽寒。"
      }
    ]
  },

  "rewriteTemplate": {
    "commonPrompt": "请严格遵循以下思维链：\n1. 绝对主角聚焦原则...\n2. 定调定位...",
    "categoryPrompts": {
      "cat_heart_demon": "【心魔纠缠场景规则】\n场景识别: 心魔互动...\n描写要点: 红绫束缚Play..."
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `breakthroughTemplate` | 破甲词。系统级注入，控制 AI 行为边界 |
| `identifyTemplate.categories` | 识别规则。数组: `id`, `name`, `conditions` |
| `rewriteTemplate.commonPrompt` | 通用改写规则，所有场景共用 |
| `rewriteTemplate.categoryPrompts` | 场景专属规则。key = `categories[].id`，一一对应 |

### 识别与改写流程

```
Scan (低级模型):
  遍历每段 → 一次性发送所有 conditions → AI 返回匹配 category 列表
  → 存入 paragraphs.scene_tags

Rewrite (高级模型):
  读取 scene_tags → 查找 categoryPrompts[id]
  → Prompt = breakthroughTemplate + commonPrompt
             + categoryPrompts["cat_xxx"]
             + {{characterStates}} + {{chapterSummaries}}
  → 调用 AI 改写 → jsonrepair → JSON.parse → 保存正文/角色/摘要
```

不匹配任何场景 → 仅用 commonPrompt。一段可匹配多个场景 → 全部注入。

### 模板管理

```
模板管理页面:
┌──────────────────────────────────────┐
│  提示词模板                           │
│                                      │
│  [+ 导入 JSON]                       │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 女魔头心魔加料模板    v1.0     │  │
│  │ 19个场景 · 导入于 2026-05-15  │  │
│  │ [预览] [导出] [复制] [删除]   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

导入校验: name 非空, breakthroughTemplate 非空, categories 至少 1 项且 id 唯一, commonPrompt 非空, categoryPrompts key 与 categories[].id 一致。

### 项目创建时选择

```
新建项目 Step 4:
┌──────────────────────────────────┐
│  提示词模板: [▼ 女魔头心魔模板]   │
│            19个场景              │
│                                  │
│  高级模型:   [▼ Claude Opus]     │
│  低级模型:   [▼ Claude Haiku]    │
│              ☐ 共用高级模型      │
│                                  │
│  [预览模板详情]                   │
└──────────────────────────────────┘
```

---

## 六、模型管理

### 模型配置弹窗

```
┌──────────────────────────────┐
│  添加/编辑模型                 │
│                              │
│  名称:     [____________]    │
│  Provider: [▼ OpenAI兼容]    │
│  Base URL: [____________]    │
│  API Key:  [____________]    │
│            ☐ 系统密钥管理器   │
│  Model ID: [____________]    │
│  温度:     [__] (0-2)        │
│  Max Tokens:[____]           │
│  超时:     [__]s (默认120)   │
│                              │
│  等级:     ● 高级  ○ 低级     │
│                              │
│  [连接测试]  [保存]  [取消]  │
└──────────────────────────────┘
```

API Key 使用系统 safeStorage 加密存储，不回退 base64。

### 任务分配

| 等级 | 任务 |
|------|------|
| 高级模型 | 改写正文 (含增量角色更新)、场景识别、初次全文总结 |
| 低级模型 | 章节摘要生成、全文角色发现、连接测试 |

用户可配置不同模型或用"共用高级模型"。

---

## 七、状态管理

### Store 拆分

```
useAppStore       — 页面路由、侧边栏、toast
useProjectStore   — 当前项目: 配置、阶段状态、章节状态
useBatchStore     — 批量进度: 队列、暂停/恢复、失败项
useContextStore   — (新增) 角色状态、章节摘要缓存
useSettingStore   — 设置: 主题、自动保存
```

### 阶段状态机

```typescript
type StageStatus = 'idle' | 'loading' | 'processing' | 'paused' | 'done' | 'error';

function useStageState(stageName: string) {
  const [status, setStatus] = useState<StageStatus>('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });

  useEffect(() => {
    resetStage();    // 清缓存 — 解决识别失效
    loadStageData(); // 重新加载
  }, [stageName]);

  return { status, progress, start, pause, resume, stop, retry };
}
```

关键规则: 每次进入阶段强制冷启动，所有缓存失效，从数据库重新加载。

---

## 八、数据库 Schema

### 保留的表

| 表 | 改动 |
|----|------|
| `projects` | 新增 `template_id`, `high_model_id`, `low_model_id`, `share_models` |
| `chapters` | 拆分 `summary_data` 为独立列，移除 `merged_text` |
| `paragraphs` | 新增 `scene_tags` JSON |
| `tasks` | 新增 `stage_phase` 字段 |

### 新增的表

| 表 | 用途 |
|----|------|
| `character_state` | 项目级角色状态追踪 (source 区分 manual/auto) |
| `chapter_summaries` | 每章改写后生成的摘要 (plot_summary + additions) |
| `templates` | 全局提示词模板 (template_json 含全部三层) |
| `models` | 全局模型配置 (tier 区分 high/low) |
| `stream_cache` | 流式响应缓存 |

```sql
CREATE TABLE character_state (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  name                TEXT NOT NULL,
  alias               TEXT,
  description         TEXT,
  state_snapshot      TEXT NOT NULL,      -- JSON
  source              TEXT DEFAULT 'auto', -- 'manual' | 'auto'
  updated_at          TEXT NOT NULL,
  updated_from_chapter INTEGER
);

CREATE TABLE chapter_summaries (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  chapter_id    TEXT NOT NULL REFERENCES chapters(id),
  plot_summary  TEXT NOT NULL,
  additions     TEXT,                     -- JSON
  created_at    TEXT NOT NULL
);

CREATE TABLE templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         TEXT DEFAULT '1.0',
  description     TEXT,
  template_json   TEXT NOT NULL,
  category_count  INTEGER DEFAULT 0,
  is_default      INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE models (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url          TEXT NOT NULL,
  api_key_encrypted TEXT,
  model_id          TEXT NOT NULL,
  temperature       REAL DEFAULT 0.7,
  max_tokens        INTEGER DEFAULT 16000,
  timeout_sec       INTEGER DEFAULT 120,
  tier              TEXT NOT NULL,         -- 'high' | 'low'
  is_default        INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

---

## 九、IPC 通道

```
db:query                — 通用查询 (替代 30+ 单表通道)
db:mutation             — 通用写入
db:batch                — 批量操作

ai:stream               — 流式改写 (高级)
ai:summarize            — 章节摘要 (低级)
ai:discover-characters  — 全文角色发现 (低级)
ai:abort                — 取消请求
ai:connection-test      — 连接测试 (低级)

context:get-states      — 获取角色状态
context:update-states   — 更新角色状态
context:get-chain       — 获取章节上下文链

fs:read-file            — 异步读文件
fs:detect-encoding      — 编码检测
fs:save-file            — 保存文件

settings:get / :set     — 设置
app:get-meta / :set-meta — 应用标记
```

---

## 十、技术选型

| 类别 | 选用 | 原因 |
|------|------|------|
| 框架 | Electron + React + Vite + Tailwind | 沿袭原版技术栈 |
| 状态管理 | Zustand | 沿用 |
| 类型系统 | TypeScript strict | 编译期拦截类型错误 |
| 虚拟滚动 | react-window | 轻量，API 简单 |
| UUID | nanoid | 比 uuid 小，计算更快 |
| JSON Repair | jsonrepair (npm) | AI 输出容错，轻量无依赖 |
| SSE 解析 | 手写 parser | 不引入依赖，处理断包 |
| 编码检测 | jschardet + iconv-lite | 沿用，已验证可靠 |
| 数据库 | better-sqlite3 + Worker 线程 | 沿用，加异步包装 |
| 构建 | electron-vite | 沿用 |
| API Key 安全 | safeStorage | 不回退 base64 |

---

## 十一、实现优先级

### Phase 1: 骨架
1. Electron + Vite + React 项目初始化 (TS strict)
2. 布局系统 (GlobalNav / Sidebar / 路由)
3. Zustand stores 骨架
4. UI 组件库
5. TXT 导入 + 章节拆分 (Web Worker)
6. 虚拟化列表

### Phase 2: AI 核心链路
7. AI 流式通信 + jsonrepair
8. 模型管理 CRUD + 连接测试
9. 提示词模板管理 + JSON 导入导出
10. 改写阶段 (单章, 不含上下文)

### Phase 3: 上下文引擎
11. ProjectContext: 角色状态追踪 + 摘要生成 + 全文角色发现
12. 跨章上下文注入 + Token 预算管理
13. Scan 阶段: 场景识别 + 三栏工作台 + 场景标记 + 手动框选
14. 批量并发控制 + 章节状态联动 + 统计面板

### Phase 4: 全流程
15. 预览阶段 + 导出阶段
16. 批量控制面板 (暂停/恢复/重试/队列可视化)
17. 角色管理页 + 摘要编辑面板 (人工兜底)
18. 总结阶段 (可选手动触发)

### Phase 5: 打磨
19. 错误分类与重试
20. DB Worker 线程 + 性能优化
21. 首次使用引导
22. 测试覆盖 (80%+)

---

## 十二、方案演进记录

### v2.0 → v2.1 (架构自审)
| # | 问题 | 修复 |
|---|------|------|
| 1 | 摘要和角色状态合并 | 不需要合并，角色状态随改写产出，摘要独立调用 |
| 2 | 缺少角色发现机制 | 用户录入 + AI 自动发现 |
| 3 | chapter_context 冗余 | 删除，由 chapter_summaries + character_state 替代 |
| 4 | 手动框选交互不完整 | 补充浮动工具栏、可视化标记 |
| 5 | 流式断点续传不可行 | 区分轻微抖动和长时间中断 |
| 6 | 缺少人工兜底 | 角色/摘要手动编辑 + 锁定 |

### v2.1 → v2.2
| # | 变更 | 内容 |
|---|------|------|
| 1 | 角色发现全 AI 化 | 双重发现: 增量追踪 + 全文扫描 |
| 2 | 处理链 3 次调用 | 改写 → 摘要(低级) → 角色发现(低级) |
| 3 | 模型分级 | 高级/低级双模型，用户分别配置 |

### v2.2 → v2.3
| # | 变更 | 内容 |
|---|------|------|
| 1 | 模板合并 | 场景规则集合并入提示词模板，一个 JSON 三层 |
| 2 | 模型管理 | 完整 CRUD + safeStorage |
| 3 | 双全局配置 | 模板 + 模型，松耦合引用 |

### v2.3 → v3.0
| # | 变更 | 内容 |
|---|------|------|
| 1 | JSON Repair | npm jsonrepair 覆盖所有 AI 响应 |
| 2 | 并发控制 | 用户自定义并发数，主进程任务队列调度 |
| 3 | 三栏工作台 | 章节状态联动 (绿/黄/红/灰) + 右侧统计面板 |
| 4 | 场景识别交互升级 | 原文内场景高亮 (AI 淡蓝/手动淡紫) + 识别结果面板 |