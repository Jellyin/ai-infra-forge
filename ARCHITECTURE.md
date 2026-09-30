# 技术架构

## 核心架构决定：内容即数据

> **加一条新学习路径 = 在 `content/paths/` 下新建一个目录。不改任何代码。**

学习内容（路径/模块/闪卡/命令/面试题/教程正文）全部以 md + yaml 存在仓库里，构建期编译进前端。这是项目可社区化扩展的根基——贡献者不需要懂 React。

## Monorepo 布局

```
ai-infra-forge/
├── content/                    # ★ 学习内容（贡献入口，无代码）
│   └── paths/<path-id>/
│       ├── path.yaml           # 路径元信息
│       └── modules/<mod-id>/   # 模块 = 一天/一章
│           ├── module.yaml     # 标题/目标/概念/清单
│           ├── guide.md        # 教程正文
│           ├── lab.md          # 动手实验（可选）
│           ├── flashcards.yaml # SM-2 闪卡
│           ├── commands.yaml   # 命令肌肉记忆训练
│           └── quiz.yaml       # 面试自测
├── apps/web/                   # React + Vite + TS 前端
├── packages/
│   ├── logic/                  # ★ 学习科学核心（纯函数 + 单测）
│   └── content-schema/         # 内容类型 + zod 校验 + Vite 插件
└── scripts/migrate-content.mjs # 一次性内容迁移脚本
```

## 数据流

```
content/**.yaml|md
      │  (构建期)
      ▼
content-schema/load.ts ── zod 校验 ──→ 失败 = 构建失败（错误信息指到文件字段）
      │
      ▼
vite-plugin → 虚拟模块 virtual:aiforge-content
      │  (import { paths })
      ▼
apps/web React 组件
      │
      ▼
packages/logic（SM-2 调度 / 命令比对 / 进度聚合）
      │
      ▼
localStorage（本地优先，零后端，aiforge: 前缀）
```

**构建期编译而非运行期 fetch** 的理由：类型安全（zod 在构建时拦截坏内容）、快、离线可用、CI 可以单独校验内容。

## 学习科学内核（packages/logic）

| 机制 | 实现 | 依据 |
|------|------|------|
| 闪卡调度 | SM-2 变体（again/hard/good 三档，ease 1.3~∞，间隔 1/6/*ease） | 间隔重复 |
| 命令训练 | 逐字符比对（correct/wrong/pending 三态） | 生成效应、肌肉记忆 |
| 进度聚合 | 清单/闪卡/命令/面试四路等权平均 | 掌握度可量化 |
| 连续学习 | 每日 activity 计数 → streak | 习惯养成 |

全部为纯函数，`node --test` 单测覆盖（8 用例），不碰 DOM —— 未来换 UI 框架可整体复用。

## 关键技术选择

- **pnpm workspace**：三包共享依赖、原子改动。
- **React + Vite + TS**：交互重（翻卡/打字比对/仪表盘），strict 模式全开（含 noUncheckedIndexedAccess）。
- **无运行时后端**：进度 localStorage 持久化；云同步是未来可选项，不是前提。
- **自研 SM-2 而非引入 FSRS**：先验证闭环有效；算法在独立包里，后续可换 ts-fsrs 而不动 UI（见 ROADMAP）。
- **自定义 CSS token**：配色经工具验证（WCAG AA；critical 红仅用于图标/大按钮不作小字正文）。暗色默认 + light + system 三态。

## 本地开发

```bash
pnpm install
pnpm dev            # vite dev server
pnpm test           # logic 单测
pnpm typecheck      # 全包严格类型
pnpm build          # 生产构建
pnpm validate:content
```
