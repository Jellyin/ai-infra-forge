---
title: 实验二 · 把一条串行反馈链改成分层并抓出一只 flake
---

# 🧪 动手实验 · Day 2

> **目标**：拿一条「所有测试塞在一个 job 里、串行跑 8 分钟」的流水线，亲手拆成有预算的分层链，再**故意养一只 flake**，看它如何被 `retry` 掩盖，最后定位到具体根因。
>
> 三档任选：**档位 A 真环境**（有 GitLab 实例）／**档位 B 本地**（无 GitLab）／**档位 C 纸上**（12 分钟，纯推理）。

---

## 档位 A · 真环境（有 GitLab 实例或 gitlab.com 项目）

### 1. 先造一条「反面教材」

```bash
mkdir -p ci-day2 && cd ci-day2 && git init -b main
cat > .gitlab-ci.yml <<'YAML'
stages: [test]

everything:
  stage: test
  script:
    - make lint
    - make typecheck
    - make test-unit
    - make test-integration
    - make test-e2e
YAML
git add -A && git commit -m "day02 baseline" && git remote add origin <你的项目地址>
git push -u origin main
```

### 2. 拆成分层链，再测关键路径

```bash
cat > .gitlab-ci.yml <<'YAML'
stages: [check, test, verify]

lint:
  stage: check
  script: [make lint]
typecheck:
  stage: check
  script: [make typecheck]

unit:
  stage: test
  needs: [lint, typecheck]
  script: [make test-unit]
integration:
  stage: test
  needs: [lint, typecheck]
  script: [make test-integration]

e2e:
  stage: verify
  needs: [unit]
  when: manual
  script: [make test-e2e]
YAML
git commit -am "split layers" && git push
```

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| 拆分前总时长 | | 五步相加 |
| 拆分后总时长 | | 应约为 `max(check) + max(unit, integration)` |
| `unit` 是否等 `typecheck` | | 是则 `needs` 没生效，检查 job 名拼写 |
| `lint` 用了几秒 | | 超过 30s 说明它不只是 lint |

### 3. 看门禁有没有真的拦人

把 `lint` 故意改成必挂，对比 `script: [make lint]`（失败 → MR 不能合并）与 `script: [make lint]` + `allow_failure: true` 两种写法。

**关键观察**：后者下 pipeline **仍是绿的**，`unit` 也不会被拦。这就是「跑得早但不阻断」——它只产出通知，不产出门禁。

### 4. 养一只 flake，看 `retry` 怎么盖住它

```bash
cat > tests/flaky.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if (( RANDOM % 3 == 0 )); then echo "flaky failure"; exit 1; fi
echo "ok"
SH
chmod +x tests/flaky.sh
```

```yaml
unit:
  stage: test
  needs: [lint, typecheck]
  retry:
    max: 2
    when: always          # ← 危险写法
  script: [./tests/flaky.sh]
```

连续 push 5 次，统计 pipeline 失败次数。然后只改一行，再 push 5 次：

```yaml
  retry:
    when: [runner_system_failure, stuck_or_timeout_failure]   # 从 always 改成精确匹配
```

| 观察项 | 你的记录 | 说明 |
|---|---|---|
| `when: always` 下的失败率 | | 明显偏低——flake 被藏起来了 |
| 精确 `when` 下的失败率 | | 接近真实概率（约 1/3 触发，×3 次尝试） |
| 同 commit 重跑是否结果不同 | | 是 → 这就是 flake 的定义 |

---

## 档位 B · 本地（无 GitLab 实例）

### 1. 用真实工具量化每一层

```bash
# 分别计时，观察「最便宜的否决」在哪
time make lint
time make typecheck
time make test-unit
```

| 你观察到的 | 结论 |
|---|---|
| lint 只花几秒 | 它该第一层跑，且必须阻断 |
| typecheck 比 lint 慢很多 | 它该并行于 lint，而不是排在 lint 之后 |
| 单测慢一个数量级 | 它是主线，但不能再往后排 |

### 2. 用乱序 + 重复执行抓 flake

```bash
# Go：打乱顺序并重复 5 次，暴露测试间共享状态
go test ./... -count=5 -shuffle=on

# Jest：先看用例数（防「零用例通过」）
npx jest --listTests | wc -l
```

| 你观察到的 | 结论 |
|---|---|
| 乱序后挂，单跑绿 | 测试间共享状态（同一 DB / 临时目录 / 全局变量） |
| `--listTests` 输出 0 | 测试选择器写错，退出码仍是 0 → 假绿灯 |
| 只在高并发时挂 | 端口冲突或资源竞争，不是逻辑错 |

**顺带记一个数**：`npx gitlab-ci-local --list` 会把 `parallel:matrix` 的每个实例都列出来，总数就是你要向 runner 池索要的并发量。本地看不出代价，但真实 runner 上它就是排队来源。

---

## 档位 C · 纸上（12 分钟，无需任何环境）

下面这段 `.gitlab-ci.yml` **有 8 处坑**，全部不会让流水线变红。先自己找，再看答案（不许先翻）：

```yaml
stages: [test, verify]

unit:
  stage: test
  parallel:
    matrix:
      - SUITE: [core, api, billing, search]
        NODE: ["18", "20", "22"]
        OS: [linux, macos]
  script:
    - npx jest --testPathPattern="$SUITE"
  retry:
    max: 2
    when: always
  coverage: '/total.*?(\d+\.\d+)%/'          # ← 待定

integration:
  stage: test
  needs: [unit]
  allow_failure: true
  script: [make test-integration]

e2e:
  stage: verify
  script: [make test-e2e]

coverage-gate:
  stage: verify
  script:
    - test "$(cat coverage.total)" -ge 80
```

<details><summary>对照答案（先写完再看）</summary>

1. **matrix 是三重乘法**：`4 SUITE × 3 NODE × 2 OS = 24 个 job`，既吃满 runner 并发，又在为不存在的目标组合（`macos` + 你的 Linux 运行时）浪费资源。资源代价必须先算再写。
2. **`retry: when: always`**：把业务失败一起重试，等于给 flake 发免死金牌。应精确到 `runner_system_failure` / `stuck_or_timeout_failure`。
3. **`integration` 的 `allow_failure: true`**：集成层是真实依赖契约的唯一防线，容忍它失败等于放弃这层门禁。
4. **`integration` 用 `needs: [unit]`**：对 matrix job 的 `needs` 会等**全部 24 个实例**，分层链退化成栅栏，下游被最慢的实例拖住。应改用 `needs:parallel:matrix` 精确选中需要的实例。
5. **`--testPathPattern` 没有零用例保护**：`$SUITE` 拼错或匹配不到时退出码仍是 0，产出假绿灯。脚本里要显式断言「用例数 > 0」。
6. **`e2e` 无 `needs` 且放在 `verify`**：它会被动等整个 `test` stage（含 24 个 unit 实例）跑完，关键路径无谓变长。应挂 `needs` 到真正需要的上游，或设 `when: manual`。
7. **覆盖率门禁是「总量 ≥ 80」**：典型误用，存量低的仓库会催生无断言测试与忽略注释。正解是卡 **diff / patch coverage**，并对 hotspot 模块单独定软下限。
8. **`coverage:` 正则不可靠**：它依赖测试输出格式，工具升级或输出改格式就静默失配，抓不到数据门禁却可能仍「通过」。**字段与正则随版本演进，用前看官方文档，并加一条「抓不到即失败」的断言。**

</details>

### 最后一问（写下你的答案，Day 5 回看）

如果有人提出「把 `retry.max` 从 2 提到 5，流水线就稳了」，你要用什么**具体数据**反驳他？写两条。

<details><summary>参考答案</summary>

① 该用例「同 commit 两次结果不一致」的**检出率**——重试次数越多，这个指标越低，问题被藏得越深；② 单次失败概率 × 重试次数，说明这只是把失败推迟到「哪一次运气不好」；③ 重试占用的 **runner 时间**对关键路径预算的侵蚀。真正要的是一条带 owner 和 deadline 的 quarantine 记录，而不是更大的 `max`。
</details>
