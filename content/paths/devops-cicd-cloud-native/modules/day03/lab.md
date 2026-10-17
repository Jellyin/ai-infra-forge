---
title: 实验三 · 亲手制造缓存假命中，再把它改对
---

# 🧪 动手实验 · Day 3

> **目标**：先体验「缓存让流水线变快了，但快在**错的输入**上」，再把 key 改对；然后把 BuildKit 的层缓存搬出 runner；最后验证多架构缓存互相污染时**根本不会报错**。
>
> 三档任选：**档位 A 真环境**（有 GitLab 实例 + Container Registry）／**档位 B 本地**（有 docker buildx）／**档位 C 纸上**（12 分钟，纯推理）。

---

## 档位 A · 真环境（有 GitLab 实例 + Container Registry）

### 1. 造一次缓存假命中

```bash
mkdir -p cache-lab && cd cache-lab && git init -b main
cat > .gitlab-ci.yml <<'YAML'
stages: [deps]

install:
  stage: deps
  cache:
    key: deps                     # ← 坑：常量 key
    paths: [.cache-state/]
  script:
    - mkdir -p .cache-state
    - cp package-lock.json .cache-state/lock.snapshot
    - echo "restored:"; cat .cache-state/lock.snapshot
YAML
```

push 两次，**改一次 `package-lock.json`** 后再 push 第三次。

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| 第三次 `lock.snapshot` 的内容 | | 仍是旧锁文件 → 假命中 |
| job 用时 | | 变快了，但快在错的输入上 |
| job 是否报错 | | 不报错——这才是危险处 |

### 2. 把 key 改成内容哈希

```yaml
  cache:
    key:
      files: [package-lock.json]
      prefix: "$CI_COMMIT_REF_SLUG"
    paths: [.cache-state/]
```

再改一次锁文件 push，确认 `lock.snapshot` 跟着更新。**这才是「命中等价于输入一致」。**

### 3. 把 BuildKit 层缓存搬出 runner

```yaml
build:
  stage: deps
  script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - docker buildx build --push
        --cache-from "type=registry,ref=$CI_REGISTRY_IMAGE:buildcache"
        --cache-to   "type=registry,ref=$CI_REGISTRY_IMAGE:buildcache,mode=max"
        -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
```

连跑两次，第二次日志里应出现标着 `CACHED` 的步骤。

### 4. 多架构污染实验

```bash
docker run --privileged --rm tonistiigi/binfmt --install all   # 让 amd64 runner 能执行 arm64
```

把 `CACHE_REF` 临时改成**不带平台后缀**的常量，跑一次 `linux/amd64,linux/arm64` 双平台构建。

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| 共享 ref 时 arm64 是否报 `CACHED` | | 命中了别的平台的层 |
| 构建是否失败 | | 多数情况下**不失败**，问题被推迟到运行期 |
| 按平台分 ref 后 | | 各平台独立命中，互不干扰 |

---

## 档位 B · 本地（有 docker buildx，无 GitLab）

### 1. 用 local 后端观察层缓存

```bash
docker buildx create --use --name cachelab
docker buildx build --load -t labapp:1 \
  --cache-from type=local,src=/tmp/bkcache \
  --cache-to   type=local,dest=/tmp/bkcache,mode=max .
docker buildx build --load -t labapp:2 \
  --cache-from type=local,src=/tmp/bkcache \
  --cache-to   type=local,dest=/tmp/bkcache,mode=max .
```

| 你观察到的 | 结论 |
|---|---|
| 第二次出现 `CACHED` | 层缓存生效 |
| 改 `COPY` 之后的那条指令 | 只有它之后的层失效——层缓存是链式的 |
| 加 `--no-cache` 后全部重跑 | 这就是「必须禁用缓存」时的对照组 |

### 2. 多平台构建与内容寻址

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t labapp:multi .   # 会报什么？
```

故意把 `--cache-from` 指向一个**存在但内容无关**的 cache ref（例如另一条流水线的 cache image）：

| 你观察到的 | 结论 |
|---|---|
| 没有复用错误的层，只是全部 miss | `--cache-from` 是导入候选，命中靠内容摘要比对 |
| 多平台结果没法 `--load` 进本地 docker | 本地镜像存储是单平台的，多平台要走 `--push` 或 OCI 输出 |
| 与 GitLab 的 `cache:key` 对比 | 后者按键取值，键不含内容就会拿到过期内容 |

---

## 档位 C · 纸上（12 分钟，无需任何环境）

下面这段配置**有 8 处缓存坑**，全部不会让流水线变红。先自己找，再看答案：

```yaml
stages: [deps, build]

variables:
  CACHE_KEY: deps

.deps-cache: &deps-cache
  cache:
    key: $CACHE_KEY
    paths:
      - node_modules/
      - .env
    policy: pull-push

install:
  stage: deps
  <<: *deps-cache
  script: [pnpm install]

build:image:
  stage: build
  needs: [install]
  script:
    - docker buildx build --platform linux/amd64,linux/arm64 --push
        --cache-from "type=registry,ref=$CI_REGISTRY_IMAGE:cache"
        --cache-to   "type=registry,ref=$CI_REGISTRY_IMAGE:cache,mode=max"
        -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .

release:
  stage: build
  needs: [build:image]
  <<: *deps-cache
  script: [make release]
```

<details><summary>对照答案（先写完再看）</summary>

1. **`key: deps` 是常量**：缓存永不失效，依赖变更后仍命中旧内容——假命中的教科书案例。至少要换成 `key: { files: [pnpm-lock.yaml], prefix: "$CI_COMMIT_REF_SLUG" }`。
2. **把 `.env` 放进 `cache.paths`**：凭证落进缓存并被其他分支共享，是投毒与泄漏的双重入口。缓存目录必须零凭证，且要有扫描断言。
3. **`node_modules/` 不是 pnpm 下该缓存的目录**：应缓存 `.pnpm-store/`。前者是符号链接丛林，解包成本还会被重复支付。
4. **key 里没有平台维度**：amd64 与 arm64 会互相污染，症状是运行时段错误而不是构建失败。
5. **多平台构建共用单个 cache ref**：`linux/amd64,linux/arm64` 虽然一次调用，但 cache manifest 需要按平台区分（稳做法是分 ref 或用支持 manifest list 的选项）。**该行为随 BuildKit 版本演进，用前看官方文档。**
6. **`release` 继承 `policy: pull-push`**：它和 `install` 写同一个 key，多 runner 并发时会互相覆盖。发布作业应只用 `policy: pull`。
7. **主干/发布流水线没有被限制写入权**：谁都能写这个 key，就存在投毒面。受保护分支之外的 pipeline 应只读（`policy: pull`）。
8. **`release` 把缓存当成了正确性来源**：缓存缺失或假命中时它会照常发布，没有任何锁文件校验。发布构建要么 `--no-cache` 重建，要么在恢复后比对锁文件哈希，把正确性交回给锁文件（`pnpm --frozen-lockfile`）。

</details>

---

## 记录

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| 假命中时的 job 用时 | | 比预期快，但输入是错的 |
| 改对 key 后的命中率 | | 每个新分支第一次必然 miss，这是正常的 |
| 第二次 BuildKit 构建的 `CACHED` 步骤数 | | 越多说明 Dockerfile 分层越合理 |
| 平台分键前的异常现象 | | 记录它是构建期报错还是运行期报错 |

### 最后一问

如果有人在事故复盘里说「把缓存全清掉就好了」，你要问他哪三个问题？

<details><summary>参考答案</summary>

① 命中的到底是**哪个 key**、这个 key 由什么内容决定？② 谁有权写这个 key（能不能被不受保护的 pipeline 写入）？③ 恢复缓存之后有没有做过**完整性校验**，还是直接信任了缓存内容？清缓存只是让问题暂时消失；不回答这三条，下次还会以另一个 key 的形式回来。
</details>
