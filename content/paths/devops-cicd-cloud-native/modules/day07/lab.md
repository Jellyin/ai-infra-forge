---
title: 实验七 · 单机做双架构构建，并用 index digest 发布与回滚
---

# 🧪 动手实验 · Day 7

> **目标**：亲手产出**一个 tag、两个架构**的 manifest list，看清 index 与单架构 digest 的区别，并用 **index digest** 做一次发布与回滚。这是本路径最核心的动手项。
>
> 三档任选：**档位 A 真环境**（有 arm64 与 amd64 runner）／**档位 B 本地**（单机用 buildx + QEMU 做双架构，**本机没有 arm64 节点也能做**）／**档位 C 纸上**（15 分钟，读构建日志与 manifest 输出下判断）。

---

## 档位 A · 真环境（有 arm64 + amd64 runner）

### 1. 一个 tag，两个架构

用 Day 7 §7.5 的 `matrix` 扇出到两种 runner 的构建，各跑一遍后，在**合并 manifest** 的那一步之前，先分别看看两个单架构镜像：

```bash
docker buildx imagetools inspect "$REG/app:$CI_COMMIT_SHA-amd64" --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect "$REG/app:$CI_COMMIT_SHA-arm64" --format '{{json .Manifest.Digest}}'
```

记下**两个不同的 digest**——它们就是「单架构 digest」。

### 2. 合并成一个 index，再看它

```bash
docker buildx imagetools create \
  -t "$REG/app:$CI_COMMIT_SHA" \
  "$REG/app:$CI_COMMIT_SHA-amd64" \
  "$REG/app:$CI_COMMIT_SHA-arm64"

docker buildx imagetools inspect "$REG/app:$CI_COMMIT_SHA"
```

**记录**：index 里应有哪些平台？index 的 digest 与两个单架构 digest 是否都不同？

| 引用对象 | digest | 覆盖架构 |
|---|---|---|
| `...-amd64` | | 仅 amd64 |
| `...-arm64` | | 仅 arm64 |
| 合并后的 tag | | amd64 + arm64（这是 **index digest**） |

### 3. 用 index digest 发布与回滚

把 index digest 记下来，用它在 K8s 里做一次发布，再回滚到上一版 index digest：

```bash
docker buildx imagetools inspect "$REG/app:$CI_COMMIT_SHA" --format '{{json .Manifest.Digest}}'
kubectl set image deploy/app app="$REG/app@sha256:<index digest>"
kubectl rollout status deploy/app
# 回滚：指回上一版 index digest，arm64 与 amd64 节点一起切回
kubectl set image deploy/app app="$REG/app@sha256:<上一个 index digest>"
```

**关键观察**：一次发布**同时**覆盖两个架构的节点。这就是为什么多架构发布必须引用 index digest——用单架构 digest 会出现「一台上、一台不上」。

---

## 档位 B · 本地（单机，用 buildx + QEMU 做双架构）

> 本机即便是 Apple Silicon 或 x86，也能用 buildx + QEMU **同时构建两个架构**，无需第二个节点。

### 1. 准备 binfmt 与 builder

```bash
# 注册 QEMU 处理器（首次一次即可；Docker Desktop 通常已内置）
docker run --privileged --rm tonistiigi/binfmt --install all

# 建一个支持多平台的 builder（docker-container driver 才支持多平台）
docker buildx create --name multi --driver docker-container --use
docker buildx inspect --bootstrap
```

### 2. 一条命令产出双架构 index

```bash
cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY main.go .
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/app main.go
FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER 65532:65532
ENTRYPOINT ["/app"]
EOF

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t localhost:5000/app:test \
  --push \
  .
```

> **本地必须有 registry 才能 `--push`**（`docker run -d -p 5000:5000 registry:2`）。**`--load` 不能加载多平台镜像**——这是新手第一个坑，别在这上面耗时间。

### 3. 看清 index，并验证两个架构真的能跑

```bash
docker buildx imagetools inspect localhost:5000/app:test

# 架构断言：拉 arm64 变体并确认它真是 aarch64
docker run --rm --platform linux/arm64 localhost:5000/app:test uname -m    # aarch64
docker run --rm --platform linux/amd64 localhost:5000/app:test uname -m    # x86_64
```

**注意**：若本机是 amd64，上面的 `arm64` 运行走的就是 QEMU 模拟——能跑通说明镜像基本可用，但**不代表性能达标**，生产验证仍要在真 arm64 节点上做。

### 4. 核心实验：模拟构建 vs 交叉编译（**记录表**）

同一份 `main.go`，用两个 Dockerfile 各构建一次 arm64 目标，记耗时：

| 构建方式 | Dockerfile 关键行 | arm64 构建耗时 | 说明 |
|---|---|---|---|
| 纯 QEMU 模拟编译 | 不用 `$BUILDPLATFORM`，直接在 arm64 阶段 `go build` | | QEMU 参与**编译**，最慢 |
| 交叉编译 + QEMU 仅装配 | `FROM --platform=$BUILDPLATFORM` + `GOARCH=$TARGETARCH` | | QEMU 不参与编译，接近原生 |

```bash
# 分别构建，观察耗时差异
time docker buildx build --platform linux/arm64 -t app:qemu   -f Dockerfile.qemu   --push .
time docker buildx build --platform linux/arm64 -t app:cross  -f Dockerfile.cross  --push .
```

**记录**：两种方式的耗时差几倍？→ 结论：**「QEMU 慢」往往慢在没做交叉编译的 Dockerfile，而不是 QEMU 本身。**

---

## 档位 C · 纸上（15 分钟，读输出下判断）

下面是某次双架构发布的部分输出，找出问题。

```
$ docker buildx build --platform linux/amd64,linux/arm64 -t reg/app:1.2.0 --load .
ERROR: docker exporter does not currently support exporting manifest lists
```

```
$ docker buildx imagetools inspect reg/app:1.2.0
Name:      reg/app:1.2.0
MediaType: application/vnd.docker.distribution.manifest.list.v2+json
Manifests:
  Name:        reg/app:1.2.0@sha256:aaaa...
  MediaType:   application/vnd.docker.distribution.manifest.v2+json
  Platform:    linux/amd64
  Name:        reg/app:1.2.0@sha256:bbbb...
  MediaType:   application/vnd.docker.distribution.manifest.v2+json
  Platform:    linux/arm64
```

```
# 发布脚本
kubectl set image deploy/app app=reg/app@sha256:aaaa...   # ← 用的是哪个 digest？
```

<details><summary>对照答案（先写完再看）</summary>

1. **`--load` 报错**：多平台构建产出一个 manifest list，本地 docker 无法表示，故 `--load` 不支持。改用 `--push`（或 `--output type=oci,dest=...`）。这不是 bug，是设计边界。
2. **index 是好的**：两个平台都在，符合预期——这一步没问题，别误判。
3. **致命错误**：`kubectl set image` 用的是 `sha256:aaaa...`，那是 **amd64 的单架构 digest**。arm64 节点会拉到 amd64 那份（或架构不匹配直接失败）→「一台上、一台不上」。正确做法是引用**顶层 index digest**（`imagetools inspect` 的 `.Manifest.Digest`，不是 `.Manifest.manifests[]` 里的子 digest）。
4. （加分）**没有测试证据**：仅凭 index 有两个平台，不能说明 arm64 那份**测过**。双架构必须补 `--platform linux/arm64` 的架构断言与冒烟测试。

</details>

### 最后一问（写下回到工作）

你团队现在的发布脚本引用的是**镜像 tag**（如 `app:1.2.0`）还是**具体 digest**？如果引用 tag，那么当 `1.2.0` 在某天被**重新构建推送**（浮动的 amd64 基础镜像变了）时，你如何保证回滚能回到**当初验证过的那一份**？

<details><summary>参考答案</summary>

引用浮动 tag 时，回滚无法保证回到验证过的字节——tag 会被后续推送覆盖，且多架构下两个架构甚至可能来自不同批次。要能精确回滚，必须记录**本次发布验证过的 index digest**（`app@sha256:<index digest>`）并将其作为唯一权威制品引用；tag 只作人类可读的别名。这正是 Day 7 把「按 index digest 晋升/回滚」列为核心动作的原因。
</details>
