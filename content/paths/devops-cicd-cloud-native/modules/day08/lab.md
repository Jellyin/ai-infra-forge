---
title: 实验八 · 抓住一次「悄悄换了制品」的发布
---

# 🧪 动手实验 · Day 8

> **目标**：不是学 registry 命令，而是**亲手复现「tag 被覆盖 → 制品漂移」**，并验证「按 digest 晋升」为什么是唯一可靠的路径。
>
> 三档任选：**档位 A 真环境**（集群 + GitLab/registry）／**档位 B 本地**（docker + crane/skopeo，无需云）／**档位 C 纸上**（15 分钟，给一组 tag/digest 与晋升记录，找出「同一次发布其实换了制品」）。

---

## 档位 A · 真环境（有一个可推拉的 registry）

### 1. 亲眼看到 tag 被覆盖

```bash
# 推第一个版本
docker build -t reg.local/api:1.4.0 build-a/ && docker push reg.local/api:1.4.0
DIGEST_A=$(crane digest reg.local/api:1.4.0)

# 改动一行代码，重新构建并推同一个 tag（模拟「手滑覆盖」）
docker build -t reg.local/api:1.4.0 build-b/ && docker push reg.local/api:1.4.0
DIGEST_B=$(crane digest reg.local/api:1.4.0)

echo "A=$DIGEST_A"; echo "B=$DIGEST_B"; [ "$DIGEST_A" = "$DIGEST_B" ] && echo "未变" || echo "tag 相同、digest 已变 —— 制品被换了"
```

**记录**：`DIGEST_A` 与 `DIGEST_B` 是否相同？所有引用 `api:1.4.0` 的部署清单，此刻被静默指向了哪个镜像？

| 观察项 | 你的记录 |
|---|---|
| tag `1.4.0` 是否还是同一个 digest | |
| 有哪些地方引用了这个 tag（部署清单/文档/其他镜像） | |
| 如果开了 tag 不可变，第二次 push 会怎样 | |

### 2. 走一次「按 digest 晋升」

```bash
# dev 上验证过 digest 后，搬到 prod，引用的是同一个 digest
SRC=reg.local/api@sha256:$(crane digest reg.local/api:1.4.0 | cut -d: -f2)
skopeo copy --all docker://$SRC docker://reg.local/prod/api:1.4.0
# 校验：搬过去之后 digest 必须没变
test "$(crane digest reg.local/prod/api:1.4.0)" = "$(crane digest reg.local/api:1.4.0)" && echo "OK：同一制品"
```

**关键观察**：这一步**没有任何构建发生**。若你的流程里出现 `docker build` 指向 prod 仓库，那就是要抓的漂移。

---

## 档位 B · 本地（有 docker + crane/skopeo，无需云）

### 1. 证明 digest 才是身份

```bash
# 用本地 tar 也可以观察：import 后看 digest
docker build -t demo:1 .
crane digest demo:1                       # 记录了当前内容
docker build --no-cache -t demo:1 .       # 重新构建同名 tag
crane digest demo:1                       # 多数情况下 digest 已变
```

对照实验：把镜像导出为 OCI 归档再导入，观察 digest 是否稳定。

| 形态 | 引用方式 | 谁变了它会变 |
|---|---|---|
| `demo:1` | tag | 任何人重推同名 tag |
| `demo@sha256:…` | digest | 只有内容变才变，无法伪造 |

### 2. 检测「为生产重新构建」

```bash
# 模拟 CI 记录 digest
crane digest demo:1 > image.digest
# 模拟「prod 重建」：重新构建并改了依赖，digest 会不同于记录值
docker build --no-cache -t demo:prod .
test "$(crane digest demo:prod)" = "$(cat image.digest)" || echo "🚨 drift：prod 制品 ≠ CI 产物"
```

写下：在你自己的项目里，**哪一步可能偷偷重建**？把这条断言放在哪个环节（CI 的 deploy job？准入策略？）最可靠？

---

## 档位 C · 纸上（15 分钟，纯推理）

下面是某个服务一次「1.4.0 发布」的晋升记录。表面上一切正常，但**同一次发布其实在 prod 换了制品**。找出证据。

```
# dev 仓库（CI 构建产出）
2026-03-02  api:1.4.0        digest=sha256:aa11...  由 ci/build job 产出 @ commit 9f31c2a
2026-03-02  api:main-9f31c2a digest=sha256:aa11...  （同上，别名）

# staging 仓库
2026-03-02  api:1.4.0-rc.1   digest=sha256:aa11...  crane copy 自 dev（同 digest，合格）

# prod 仓库
2026-03-03  api:1.4.0        digest=sha256:bb22...  job=ci/build (branch=release/1.4)
```

另外，部署清单片段：

```yaml
image: registry.example.com/prod/api:1.4.0
imagePullPolicy: IfNotPresent
```

<details><summary>对照答案（先写完再看）</summary>

1. **prod 的 digest 变了**：dev 产出是 `aa11…`，prod 的 `1.4.0` 却是 `bb22…`。晋升本应搬运同一 digest，这里 digest 不同＝**prod 跑的不是 dev/staging 验证过的那个制品**。
2. **prod 是「重新构建」出来的**：prod 记录的 `job=ci/build (branch=release/1.4)`——不是 copy，而是又跑了一次 build。这就是漂移：源码可能一样，但基础镜像/依赖/构建环境不同，**prod 是一个从未被 rc 验证过的二进制**。
3. **部署清单用 tag，而不是 digest**：`image: …prod/api:1.4.0` 是可变指针，将来再被覆盖也无感知。应写 `@sha256:…`。
4. **`imagePullPolicy: IfNotPresent` 放大问题**：节点缓存了旧 digest 就不再拉，于是不同节点上「同一个 1.4.0」可能真不是同一个镜像。
5. （加分）**release/changelog 里没带 digest**：只有版本号和 commit，无法事后核对到底发了哪份制品。

修复方向：prod 仓库对 CI 只给 copy 权限；晋升脚本断言 digest 相等（`test … = …`）；部署清单钉死 digest；changelog/Release 里记录 digest。

</details>

### 最后一问（写下你的答案，Day 9 回看）

假设你已经用 `test "$(crane digest prod/api:1.4.0)" = "$(cat image.digest)"` 挡住了上面的漂移。**这仍然挡不住哪一类攻击**？写下至少两条你现在还无法确认的事：

1. ____________________
2. ____________________

<details><summary>参考答案</summary>

digest 相等只证明「prod 里的制品和 CI 产出**逐字节一致**」，但**不能证明它就是你这条流水线构建的**——有人可以直接构建一个恶意镜像并把 digest 换成一样吗？不行（digest 由内容定），但他可以在**构建阶段**就植入后门，让 CI 自己产出被污染的制品；也可以用一条**伪造的流水线**推一个 digest、再让内部人员放行。digest 相等回答的是「是不是同一份」，回答不了「这份是谁、以什么源码和构建步骤产出的」。后者要靠 **provenance（构建来源证明）** 与**签名**——正是 Day 9 的主题。

</details>
