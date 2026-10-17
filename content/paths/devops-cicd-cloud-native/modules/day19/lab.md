---
title: 实验十九 · 把一条流水线抽象成可复用、可发版的组件
---

# 🧪 动手实验 · Day 19

> **目标**：亲手把「一段人人复制的流水线」抽成一个**有版本、有弃用策略的组件**，再制造一次「模板升级」的连锁反应，看清爆炸半径是怎么来的。
>
> 三档任选：**档位 A 真环境**（有 GitLab 实例 / 可建组件项目）／**档位 B 本地**（无 GitLab，用 CLI 渲染与校验）／**档位 C 纸上**（15 分钟，纯推理）。

---

## 档位 A · 真环境（GitLab 实例或 gitlab.com）

### 1. 建一个组件项目，发布 v1.0.0

GitLab 的 CI Component 放在一个带 `templates/` 目录的项目里，catalog 按 **tag** 解析版本。

```bash
# 仓库：ci-components（组件目录）
mkdir -p ci-components/templates/build-docker && cd ci-components
cat > templates/build-docker/template.yml <<'YAML'
spec:
  inputs:
    stage:
      default: build
    image_name: {}
    context:
      default: "."
---
build-docker:
  stage: $[[ inputs.stage ]]
  script:
    - echo "构建 $[[ inputs.image_name ]]（context=$[[ inputs.context ]]）"
    - docker build -t "$CI_REGISTRY_IMAGE/$[[ inputs.image_name ]]:$CI_COMMIT_SHA" "$[[ inputs.context ]]"
YAML
git init -b main && git add -A && git commit -m "build-docker v1"
git tag 1.0.0 && git push -u origin main && git push origin 1.0.0
```

**记录**：组件在 catalog 里的路径是 `<项目全路径>/build-docker@1.0.0`（随实例配置略有差异，以 catalog 页面显示为准）。

### 2. 在两个业务仓库里引用它

```bash
# 业务仓库 payments-api 的 .gitlab-ci.yml
cat > .gitlab-ci.yml <<'YAML'
include:
  - component: <你的组>/ci-components/build-docker@1.0.0
    inputs:
      image_name: payments-api
YAML
```

在**两个**仓库里各引用一次（比如 `payments-api` 和 `orders-api`），推上去，确认两条流水线都跑通。

### 3. 制造一次「模板升级」的连锁反应——关键实验

分两步走，观察差异：

```bash
cd ci-components
# 改 component：把 image_name 拆成必填的 registry 前缀 + 名字（不兼容变更）
# 发布 2.0.0
git commit -am "breaking: split image_name" && git tag 2.0.0 && git push origin 2.0.0
```

此时**什么都不改业务仓库**，触发一次它们的流水线，观察：

| 观察项 | 你的记录 | 说明了什么 |
|---|---|---|
| 引用 `@1.0.0` 的仓库是否受影响 | | 版本固定的作用：**只影响主动升级的人** |
| 若把引用改成 `@main` 再触发 | | 爆炸半径 = 引用该分支的全部仓库 |
| catalog 上 v1.0.0 是否仍可用 | | 弃用要留缓冲期，不能删了就走 |

**这一步是全实验的核心**：同一个 breaking change，`@1.0.0` 和 `@main` 的后果天差地别。

### 4. 走一遍弃用四步

对 v1.0.0 写弃用计划，实际落地一小步即可：在 v1.0.0 的 job 里加一行 `echo "⚠️ v1.0.0 已弃用，请升级到 2.0.0"`，即「软警告」阶段。

---

## 档位 B · 本地（无 GitLab 实例）

用官方 CLI 静态校验 + 本地执行器渲染，验证「组件展开后长什么样」。

```bash
# 1. 校验组件与调用方的语法（随版本演进，拿不准先看 --help）
glab ci lint .gitlab-ci.yml

# 2. 本地列出展开后的全部 job，确认 component 被正确 include
npx gitlab-ci-local --list

# 3. 只跑某个 job，验证 inputs 是否传到
npx gitlab-ci-local build-docker
```

对照实验（**重点看 inputs 有没有生效**）：

| 你观察到的 | 结论 |
|---|---|
| `--list` 里出现了 `build-docker` | include 生效，路径/版本正确 |
| job 里回显出你传的 `image_name` | `inputs` → `$[[ inputs.x ]]` 替换正确 |
| 报「component not found」 | 版本 tag 不存在或路径拼错——**这类错误只校验语法是查不出的** |

再用 git 模拟发版，体会「版本固定」：

```bash
git tag 1.0.0            # 组件仓库打版本
git tag -l '1.*.*'       # 列出已有版本，规划 1.1.0 / 2.0.0
```

**记录**：写一句话说明——如果业务仓库写的是 `@main`，平台推送一次改动会波及多少仓库？你打算怎么在团队里阻止这种写法？

---

## 档位 C · 纸上（15 分钟，无需任何环境）

下面是一个团队提上来的「通用构建组件」的 `spec.inputs`。请判断：**哪些是合法差异（该留），哪些是伪差异（该拒、让团队去分叉）**？再指出它违反了哪条抽象粒度原则。

```yaml
spec:
  inputs:
    stage:            { default: build }
    image_name:       {}
    dockerfile:       { default: Dockerfile }
    registry:         { default: "$CI_REGISTRY" }
    build_args:       { default: "" }
    cache_from:       { default: "" }
    run_unit_tests:   { default: "true" }
    test_command:     { default: "pytest -q" }
    run_sast:         { default: "true" }
    sast_severity:    { default: "high" }
    skip_if_docs_only:{ default: "false" }
    team_x_fast_mode: { default: "false" }   # 只有 team-x 在用
    notify_slack:     { default: "false" }
```

<details><summary>对照答案（先写完再看）</summary>

**该留的（合法差异）**：`stage`、`image_name`、`dockerfile`、`build_args`、`cache_from`——构建一个镜像真正需要的、每个团队确实不同的变量。

**该拒的（伪差异 → 分叉）**：
- `team_x_fast_mode`：只服务一个团队，**是分叉不是参数**，直接拒绝，让 team-x 自己分支并自担维护成本。
- `run_unit_tests` / `test_command` / `run_sast` / `sast_severity`：这些是**别的能力**（测试、扫描），被塞进了「构建」组件。应拆成独立组件，而不是给构建组件加开关。
- `skip_if_docs_only`：属于**触发策略**（`rules`），不是构建输入。
- `notify_slack`：属于**通知**，又一个独立能力。

**违反的原则**：
1. **一个组件只做一件事**——这里塞了构建、测试、扫描、通知四件事，输入已超过一只手。
2. **参数化是承诺**——每多一个输入都是平台要长期维护的兼容负担；把能力拆成组件，比把开关堆成瑞士军刀更可维护。
3. **伪差异用分叉承接**——只有一个消费者的输入，应让消费者自己 fork。

</details>

### 最后一问（写下你的答案）

你的平台里，**一个团队想改一条流水线规则时，需要谁动手**？是「改自己仓库里的一个 inputs」，还是「提 issue 等平台排期」？把现状写下来——如果答案偏后者，你已经找到了 Day 19 的那条反模式。
