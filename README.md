<div align="center">

# 🔥 AI Infra Forge

**面向「运维/工程师转型 AI Infra」的实战学习闭环平台**

路线图 · 间隔重复 · 命令实操 · 掌握度反馈 —— 不只告诉你学什么，而是验证你真的会了。

</div>

---

## 这是什么

大多数学习资源是「一堆链接」或「一堆文档」：看完就忘、不知道自己会不会、不敢动手。
AI Infra Forge 把一条学习路径拆成四种训练方式，形成**可量化的掌握度闭环**：

| 模块 | 训练方式 | 学习科学依据 |
|------|---------|-------------|
| 📋 学习路径 | 按天推进，概念 + 可勾选清单 | 明确目标 + 主动检核 |
| 🃏 闪卡复习 | SM-2 间隔重复翻卡自评 | 间隔重复抗遗忘 |
| ⌨️ 命令训练 | 逐字符敲命令，实时比对 | 肌肉记忆（生成效应） |
| 💼 面试自测 | 先答再对，如实自评 | 提取练习（testing effect） |

仪表盘聚合四路进度 → 总掌握度、连续学习天数、每日到期复习队列。

## 第一条路径

**AI Infra / MaaS 平台工程师 · 10 天**（`content/paths/ai-infra-engineer/`）
面向 5 年+ 传统运维/DevOps：推理原理、GPU 调度、高并发治理、可观测性、FinOps、平台化。

## 快速开始

### 方式一：本地开发

```bash
# 需要 Node ≥22.6 与 pnpm ≥9
pnpm install
pnpm dev          # 打开 http://localhost:5173
```

### 方式二：Docker 运行

```bash
docker compose up -d --build    # 打开 http://localhost:8080
```

多阶段构建：构建期把 content/ 编译进静态产物（保持「内容即数据、构建期加载」架构），运行时只有 nginx 静态服务，镜像极小、无运行时依赖。

> 国内网络拉基础镜像超时的话，在 Docker Desktop → Settings → Docker Engine 里配置 `registry-mirrors` 后重试。

```bash
pnpm test         # 运行学习逻辑单元测试
pnpm typecheck    # 全 workspace 严格类型检查
pnpm build        # 生产构建
pnpm validate:content   # 校验 content/ 内容模式
```

## 内容即数据（本项目最核心的架构决定）

学习内容不在代码里，在 `content/` 里。**新增一条学习路径 = 新建一个目录，不改任何代码：**

```
content/paths/<你的路径名>/
├── path.yaml              # 路径元信息（标题/受众/描述）
└── modules/<模块名>/
    ├── module.yaml        # 标题/目标/概念/清单
    ├── guide.md           # 教程正文
    ├── lab.md             # 动手实验（可选）
    ├── flashcards.yaml    # 闪卡（front/back）
    ├── commands.yaml      # 命令训练（hint/cmd）
    └── quiz.yaml          # 面试题（q/a）
```

构建期由 Vite 插件读入并经 zod 校验成类型安全数据；内容写错会在构建时报错。

## 贡献

- **加内容**（最欢迎）：写 md/yaml 就行，见 [CONTRIBUTING.md](CONTRIBUTING.md)
- **提路径建议**：开 issue 描述目标人群与大纲
- **改平台**：代码在 `apps/web`（React）与 `packages/`（logic / content-schema）

## 目录结构

```
ai-infra-forge/
├── content/paths/          # 学习内容（md + yaml，贡献入口）
├── apps/web/               # React + Vite + TS 前端
├── packages/logic/         # 学习科学核心（SM-2 / 命令比对 / 进度）+ 单测
├── packages/content-schema/# 内容类型 + zod 校验 + Vite 构建期插件
├── PRODUCT.md              # 产品定位与差异化
├── ROADMAP.md              # 路线图与社区机制
└── ARCHITECTURE.md         # 技术架构
```

## License

MIT
