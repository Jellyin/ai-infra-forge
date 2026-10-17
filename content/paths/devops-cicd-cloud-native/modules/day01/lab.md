---
title: 实验一 · 亲手制造并抓出「假绿灯」
---

# 🧪 动手实验 · Day 1

> **目标**：不是学语法，而是**亲手制造出「流水线是绿的、但什么都没测到」的场景**，再把它抓出来。你如果是老 DevOps，一定见过这类事故——本实验让它在可控环境里复现一次。
>
> 三档任选：**档位 A 真环境**（有 GitLab 实例）／**档位 B 本地**（无 GitLab，用 CLI + 本地执行器）／**档位 C 纸上**（12 分钟，纯推理）。

---

## 档位 A · 真环境（有 GitLab 实例或 gitlab.com 项目）

### 1. 建一个最小项目，观察四层结构

```bash
mkdir -p ci-lab && cd ci-lab && git init -b main
cat > .gitlab-ci.yml <<'YAML'
stages: [build, test]

build:a:
  stage: build
  script:
    - echo "building A"
    - sleep 8          # 故意变慢，用来观察关键路径
build:b:
  stage: build
  script: [echo "building B"]

test:a:
  stage: test
  needs: [build:a]     # 不等 build:b
  script: [echo "testing A"]
YAML
git add -A && git commit -m "day01 lab" && git remote add origin <你的项目地址>
git push -u origin main
```

到 **Build → Pipelines** 观察三件事，记下来：

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| `test:a` 何时启动 | | 若它在 `build:b` 之前就跑了，说明 `needs` 生效 |
| 关键路径总时长 | | 应是 `max(build:a, build:b) + test:a`，而非两者相加 |
| job 有没有 pending | | 有 pending 说明是 runner 资源问题，不是 job 慢 |

### 2. 制造一次「幽灵 job」

```bash
git checkout -b feature/x
cat >> .gitlab-ci.yml <<'YAML'

lint:
  stage: test
  rules:
    - if: $CI_COMMIT_BRANCH == "release"    # 只在 release 分支跑
  script: [echo "lint 跑了"]
YAML
git add -A && git commit -m "add lint (won't run on MR)" && git push -u origin feature/x
```

去 **Merge requests** 创建 MR，然后展开该 MR 的 pipeline：

**关键观察**：MR 页面显示 pipeline 通过，但 **`lint` 这个 job 根本不存在**。这就是幽灵 job——绿灯没有骗你说「失败了」，它只是**没有声称自己测过 lint**。

### 3. 制造一次「缓存假命中」

```bash
cat >> .gitlab-ci.yml <<'YAML'

deps:
  stage: test
  cache:
    key: deps            # ← 坑：key 里没有锁文件哈希
    paths: [.ci-deps/]
  script:
    - mkdir -p .ci-deps
    - echo "lockfile-v1" >> .ci-deps/state
    - cat .ci-deps/state
YAML
```

连续触发两次，然后**改一下「锁文件」**再触发第三次：你会发现 `state` 里是旧内容——因为 `key: deps` 恒定，缓存从不失效。**测试会跑在过期依赖上。**

**记录**：把 key 改成依赖锁文件哈希（`key: { files: [pnpm-lock.yaml] }`）再试一次，对比行为差异。

---

## 档位 B · 本地（无 GitLab 实例）

### 1. 先用官方 CLI 静态校验

```bash
# GitLab 官方 CLI（glab）——子命令与参数随版本演进，拿不准先看 --help
glab ci lint .gitlab-ci.yml
glab ci status
```

**注意**：`lint` 只校验**语法与结构**，不校验语义（比如「这个 `needs` 指向不存在的 job」在部分版本里仍会通过）——所以它给不了「假绿灯」的防护，这正说明为什么需要档位 C 的推理训练。

### 2. 用本地执行器真跑一遍

```bash
# gitlab-ci-local：在本地按 .gitlab-ci.yml 执行 job（需要本地有 docker）
npx gitlab-ci-local --list
npx gitlab-ci-local test:a
```

对照实验（重点看**依赖顺序**）：

```bash
npx gitlab-ci-local --needs build:a
```

| 你观察到的 | 结论 |
|---|---|
| 只跑了 `build:a` 及其下游 | `needs` 的依赖链在本地也成立 |
| 报「job 不存在」 | 依赖写错了名字——**这类错误在真实流水线里常常只是静默跳过** |

---

## 档位 C · 纸上（12 分钟，无需任何环境）

下面这段 `.gitlab-ci.yml` **有 8 处坑**，全部不会让流水线变红。先自己找，再看答案（不许先翻）：

```yaml
stages: [build, test, deploy]

build:
  stage: build
  script:
    - npm run build | tee build.log
  artifacts:
    paths: [dist/]

test:
  stage: test
  script:
    - npm test -- --grep="$SUITE"
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  allow_failure: true

deploy:
  stage: deploy
  when: manual
  script:
    - kubectl apply -f k8s/
```

<details><summary>对照答案（先写完再看）</summary>

1. **`tee` 吞掉退出码**：`npm run build | tee build.log` 的退出码是 `tee` 的，构建失败也会「成功」→ 需要 `set -o pipefail`。
2. **artifacts 没有 `expire_in`**：产物永久累积，是隐性的存储账单。
3. **`test` 只在 main 跑**：MR 上不存在这个 job（幽灵 job），门禁形同虚设。
4. **`$SUITE` 未定义**：`--grep=""` 会匹配到 0 个用例 → **零用例通过**（退出码 0）。
5. **`allow_failure: true`**：即便真的失败也不阻断——测试阶段的阻断能力被主动放弃。
6. **`deploy` 是 `when: manual`**：没人点就永远不部署，但流水线仍显示「通过」。
7. **`kubectl apply` 直连集群**：CD 绕过声明式来源（Day 12 会论证为什么这必须改掉），且脚本里必然藏着长期凭证。
8. **没有 `workflow:rules`**：任何分支的任何 push 都会拉起全套 job，runner 被无意义消耗。

</details>

### 最后一问（写下你的答案，Day 5 回看）

如果这条流水线「全绿」，作为负责人你能据此宣布「这次发布是安全的」吗？**写下三条你现在无法确认的事**：

1. ____________________
2. ____________________
3. ____________________

<details><summary>参考答案</summary>

至少包括：① 测试是否真的跑了用例（数量）；② 构建产物是不是**本次代码**产出的（缓存假命中）；③ 部署的到底是不是这份产物（`kubectl apply` 直连，无制品关联）。这三条正是后面 20 天要逐条补上的。
</details>
