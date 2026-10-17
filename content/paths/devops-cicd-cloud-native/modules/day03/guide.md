---
title: 缓存与构建加速
---

# Day 3 · 缓存与构建加速

## 3.1 cache 与 artifacts 是两套生命周期，不能互换

| | `cache:` | `artifacts:` |
|---|---|---|
| 语义 | 加速用，可有可无 | 产物，下游要消费 |
| 生命周期 | 跨 pipeline 滚动覆盖 | 属于本次 pipeline，按 `expire_in` 清理 |
| 缺失时 | 仍应构建成功（只是慢） | 下游拿不到就是错 |
| 存储位置 | runner 本地卷 / 分布式对象存储 | GitLab 服务端对象存储 |
| 跨 job | 同 key 即可共享 | 需 `needs` / `dependencies` 传递 |
| 默认行为 | `policy: pull-push` | 随 stage 结束传递 |

**没有它构建就错的是 artifacts**——编译产物、测试报告不进 `cache`，`node_modules` 不进 `artifacts`。**空缓存必须是合法执行路径**，否则换 runner / 清卷 / key 变更会集中爆炸。

## 3.2 cache key：必须由内容决定，且别只含一个维度

```yaml
cache:
  key:
    files:
      - pnpm-lock.yaml
    prefix: "$CI_COMMIT_REF_SLUG-node$NODE_VERSION"
  paths:
    - .pnpm-store/
```

| key 形态 | 命中率 | 正确性 | 适用 |
|---|---|---|---|
| 常量（如 `key: deps`） | 100% | **错** | 永不——它就是「缓存假命中」的定义 |
| 分支名 | 中 | 中 | 依赖不常变、要隔离分支时 |
| 锁文件哈希 | 低-中 | 对 | 推荐默认 |
| 分支 + 锁文件哈希 | 中 | 对 | 大多数场景 |
| 锁文件哈希 + 工具链版本 | 低 | 对 | 有原生扩展 / 需精确复现 |

**易错点**：`files` 的文件路径条数有上限——**默认 2 条，GitLab 19.5 起可到 10 条**（需开启 `increase_ci_cache_key_files_limit`，默认关闭），超了要自算哈希写进变量；纯内容 key 每分支首次必 miss。**工具链版本必须进 key**——Node 主版本变而锁文件没变时原生模块会错。

## 3.3 monorepo：锁文件哈希 + 目录级缓存

- **单一根锁文件**（pnpm / npm workspace）：用根锁文件哈希。
- **多锁文件**：每个被依赖的锁文件都进 key，否则改 A 包会命中 B 包旧缓存。
- **目录级缓存**：按 package 分 key；pnpm 缓存 `.pnpm-store/` 比 `node_modules/` 稳。

```yaml
cache:
  key:
    files: [pnpm-lock.yaml]
    prefix: "$CI_COMMIT_REF_SLUG"
  paths: [.pnpm-store/, .turbo/]
```

配 `fallback_keys` 回退，避免全量重装。**以官方文档为准。**

## 3.4 BuildKit 缓存必须外置，且它是内容寻址的

本地层缓存在 builder 里，换 runner 就没，必须外置：

```bash
docker buildx build \
  --push -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" \
  --cache-from type=registry,ref="$CI_REGISTRY_IMAGE:buildcache" \
  --cache-to   type=registry,ref="$CI_REGISTRY_IMAGE:buildcache",mode=max \
  .
```

后端四选一：`type=registry`（多 runner 首选）、`type=s3`、`type=local`（单台持久 runner）、`type=gha`。`mode=max` 缓存**所有**中间层，`mode=min` 只导最终段。

**关键区别**：BuildKit 按内容摘要命中（ref 相同也不复用过期层）；GitLab `cache:key` 按键取值，键不含内容就拿到过期内容。

## 3.5 多架构：按平台分键，别互相污染

不同架构产物**本质不同**：node-gyp 原生模块、Python wheel、Go 的 cgo、Rust 目标三元组、基础镜像层都不通用。amd64 产出被 arm64 命中，症状是链接失败或段错误，**而非构建报错**。

```yaml
build:image:
  parallel:
    matrix:
      - TARGETARCH: [amd64, arm64]
  variables:
    PLATFORM: linux/$TARGETARCH
    CACHE_REF: "$CI_REGISTRY_IMAGE:buildcache-$TARGETARCH"
  script:
    - docker buildx build --platform "$PLATFORM"
        --cache-from "type=registry,ref=$CACHE_REF"
        --cache-to   "type=registry,ref=$CACHE_REF,mode=max"
        -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-$TARGETARCH" .
```

依赖缓存同理，把平台写进 prefix（`"$CI_COMMIT_REF_SLUG-$TARGETARCH"`）。

**最易写错**：别用 `$CI_RUNNER_EXECUTABLE_ARCH`——交叉编译下它恒为 `amd64`；**必须用目标平台** `TARGETARCH` / `TARGETPLATFORM`。registry cache 也按平台分 ref。

## 3.6 缓存投毒与「假命中」

投毒三条路径：分布式缓存可被任意 pipeline 写同一 key（恶意分支写、主干读）；构建产物被下游直接执行；拉取不受信任的远程 cache image。

| 缓解措施 | 做法 |
|---|---|
| 让键绑定内容 | 优先内容寻址（BuildKit / 锁文件哈希），把键与内容绑死 |
| 收紧写入权 | 主干与发布流水线用 `cache:policy: pull`，仅受保护分支 `pull-push` |
| 缓存不落凭证 | 缓存目录绝不出现 token / `.env`，扫描命中即失败 |
| 恢复后校验 | 比对锁文件哈希与缓存元数据，不一致就丢弃重装 |
| 正确性交给锁文件 | `npm ci` / `pnpm --frozen-lockfile`：缓存只加速，锁文件才是真相 |

**必须禁用缓存**：可复现构建验证；安全扫描基线（要扫真实依赖而非缓存）；多 runner 并发写同一 key；依赖源被投毒后的紧急处置（`--no-cache` / `--pull`）。

## 3.7 本项目的缓存矩阵

填满是本模块产出（`docs/cache-matrix.md`），**key 一列按 3.2 / 3.5 填**：

| 什么缓存 | 存哪 | key | 含平台维度 | policy | 失效条件 |
|---|---|---|---|---|---|
| 依赖（pnpm-store） | CI cache（分布式） | 锁文件哈希 + 分支 + 工具链版本 | 是 | 主干 pull / 分支 pull-push | 锁文件变更 |
| 构建层 | registry cache image | 镜像名 + 平台（分 ref） | 是 | pull-push | 内容摘要变化 |
| 增量编译产物 | CI cache | 源码内容哈希 | 是 | pull-push | 源码变更 |
| 测试报告 | artifacts（不是 cache） | 不适用 | 否 | — | `expire_in` |

填不出来，说明这套缓存没被设计过。

## 3.8 Actions 对照：行为差异比语法更重要

| 能力 | GitLab CI | GitHub Actions |
|---|---|---|
| 缓存声明 | `cache:` | `actions/cache` |
| key 自动哈希 | `cache:key:files`（内置） | 手写 `${{ hashFiles('**/lock') }}` |
| 回退 | `cache:fallback_keys` | `restore-keys`（**前缀匹配**，语义不同） |
| 分支作用域 | 按 key，跨分支可共享 | 默认**按分支隔离**；主干缓存对所有分支可见，分支缓存不回流主干 |
| 可变性 | 每次 push **覆盖**同 key | 缓存**不可变**，同 key 写过就改不了 |
| 容量 | 由你的对象存储决定 | 每仓库约 10 GB，LRU 淘汰 |
| 构建缓存 | `--cache-to type=registry` | `--cache-to type=gha`（有上限，可用 `scope` 分区） |

**最要命的差异是不可变性**：Actions 里不含内容哈希的 key 把旧内容**永久冻住**，GitLab 同 key 会被覆盖——故障形态不同。

## 3.9 今天要建立的判断力

- 看到缓存先问：**key 由内容决定吗？没有它会怎样？**
- 看到跨架构共享缓存，问：**平台维度用的是目标架构吗？**
- 看到缓存里放着依赖，追问：**恢复后校验过吗？谁有权写这个 key？**
- 看到「清了缓存就好了」，别急着清——那是投毒或假命中的信号。
