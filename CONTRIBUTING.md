# 贡献指南

感谢你愿意贡献！这个项目的核心资产是**学习内容**，而贡献内容的门槛被刻意压到最低：只需要写 markdown 和 yaml。

## 三种贡献方式

### 1. 加内容（最欢迎 ⭐）

**修正现有内容**：直接改 `content/paths/**` 下对应文件，提 PR。

**新增一条学习路径**：

```
content/paths/<路径名>/
├── path.yaml          # 必需
└── modules/<模块>/
    ├── module.yaml    # 必需
    ├── guide.md       # 建议
    ├── flashcards.yaml
    ├── commands.yaml
    └── quiz.yaml
```

**path.yaml**

```yaml
id: my-path                 # 唯一 id（目录名一致）
title: 路径标题
subtitle: 一句话副标题
audience: 面向谁
description: 稍长的介绍
version: 0.1.0
```

**module.yaml**

```yaml
id: day01                   # 模块内唯一
title: 模块标题
goal: 学完本模块能做什么      # 写「能做什么」，不写「包含什么」
order: 1                    # 排序
read: 20                    # 建议阅读分钟（可选）
lab: 30                     # 建议动手分钟（可选）
concepts: [概念A, 概念B]
checklist:
  - 能独立完成 X
  - 能解释 Y 为什么
```

**flashcards.yaml**

```yaml
- id: day01-c1              # 模块内唯一
  front: 问题（一句话）
  back: 答案（两三句话，别贪长）
```

**commands.yaml**

```yaml
- hint: 这条命令干什么用的
  cmd: 实际要敲的完整命令
```

**quiz.yaml**

```yaml
- q: 面试问题
  a: 参考答案要点
```

提交前本地自检：

```bash
pnpm install
pnpm validate:content   # zod 会校验你的 yaml，字段写错立刻报错
```

> 内容写错不会崩应用：构建期校验会直接失败，错误信息会指出是哪个文件哪个字段。

### 2. 提路径提案

完整路径工作量大，**先开 issue 对齐再动笔**（宁可早拒，不要你写完十万字再拒）。提案写清：

1. 目标人群（越具体越好，如「有 K8s 经验想转 AI 平台」）
2. 学完能做什么（3~5 条可验证的能力）
3. 模块大纲（先到模块粒度，不用写卡片）

### 3. 改平台代码

- `apps/web/`：React 组件
- `packages/logic/`：学习核心算法（改动必须带单测）
- `packages/content-schema/`：内容模式（改动需同步更新本文件示例）

要求：`pnpm typecheck && pnpm test && pnpm build` 全绿再提 PR。

## 内容质量红线

- **不抄**：内容必须自己写，引用官方文档要注明来源
- **清单写可验证的能力**：「能说出 X 的三个权衡」优于「了解 X」
- **闪卡答案短**：闪卡是提取线索，不是教程
- **命令是真实可跑的**：不接受伪代码

## 开发环境

```bash
pnpm install
pnpm dev          # 本地开发
pnpm test         # 单测（学习算法回归保障）
pnpm typecheck    # 严格类型检查
pnpm build        # 生产构建
```

## License

提交即表示你同意以 MIT 协议发布你的贡献。
