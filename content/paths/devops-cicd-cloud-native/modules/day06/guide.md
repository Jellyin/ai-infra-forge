---
title: 镜像构建的现代方案
---

# Day 6 · 镜像构建的现代方案

## 6.1 四种构建方案：先问「谁在构建、以谁的身份构建」

选构建器不是选「哪个快」，而是选**边界**：构建进程跑在哪里、需要什么特权、爆炸半径有多大。

| 方案 | 构建进程所在 | 特权要求 | 代价 / 边界 |
|---|---|---|---|
| **BuildKit rootless** | 无名 daemon，以非 root 用户跑 `buildkitd`（rootlesskit + user namespace） | 无需 `privileged`，无需挂 socket | 需要内核支持 user namespace；部分存储驱动受限 |
| **Buildah** | 无长期 daemon，直接以当前用户 `buildah bud` | 无需 `privileged`（rootless 模式） | rootless 需 `fuse-overlayfs` 或 `vfs` 存储驱动，性能与兼容性略打折 |
| **DinD**（Docker-in-Docker） | job 内起一个**独立**的 `dockerd`（`docker:dind` service） | 通常需要 `privileged` runner | 隔离干净，但 privileged 容器本身仍是一个大权限面 |
| **socket 绑定** | 直接用**宿主机**的 `dockerd` | 挂载 `/var/run/docker.sock` | 最省事，也最危险——见下 |

### socket 绑定为什么等于给宿主 root

把 `/var/run/docker.sock` 挂进 job，等于把**宿主机 Docker daemon 的控制权**交给这段脚本。拿到它就能：

```bash
# 起一个特权容器，把宿主机根挂进来
docker run --rm -it --privileged -v /:/host alpine chroot /host sh
```

这就是宿主 root。而在 CI 里，**任何能推进一次 pipeline 的人（包括外部 MR、被污染的依赖）都能触发这段脚本**。它绕过了所有镜像、所有隔离——你在 job 里写的 `image:` 形同虚设。所以「CI 挂 docker.sock」在安全评审里应默认判红。

### 各方案的 GitLab CI 骨架

```yaml
# ① rootless BuildKit（无需 privileged，推荐默认）
build:rootless:
  image: moby/buildkit:rootless
  variables:
    BUILDKITD_FLAGS: --oci-worker-no-process-sandbox
  script:
    - buildctl-daemonless.sh build
        --frontend dockerfile.v1
        --local context=.
        --opt filename=Dockerfile
        --output type=image,name=$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA,push=true

# ② Buildah（无 daemon，rootless 好）
build:buildah:
  image: quay.io/buildah/stable
  variables:
    STORAGE_DRIVER: vfs
  script:
    - buildah bud --layers -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
    - buildah push --digestfile digest "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"

# ③ DinD（需要 privileged runner）
build:dind:
  image: docker:27
  services:
    - name: docker:27-dind
      alias: docker
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: "/certs"
  script:
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
```

> **默认判断**：能用 rootless BuildKit / Buildah 就不要 DinD，绝不要挂 socket。DinD 只在「确实需要完整 docker CLI 行为且 runner 允许 privileged」时才用。

## 6.2 多阶段构建 + distroless + 非 root

构建阶段的编译器/包管理器**不该进最终镜像**。多阶段是标配，distroless 与 `USER` 是收口。

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/app

# 运行阶段：distroless static 基础 + nonroot 变体
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER 65532:65532
ENTRYPOINT ["/app"]
```

要点：

- **distroless** 去掉 shell 与包管理器，攻击面小、体积小；代价是排障手段少（没有 `sh`），必要时用 `debug` 变体或无特权边车。
- **`USER` 非 root**：distroless 的 `nonroot` 变体默认 uid/gid `65532`。K8s 侧再叠一层 `runAsNonRoot: true` 做双保险。
- **`--mount=type=cache`** 让构建缓存不落进镜像层，比「合并 RUN」更干净。

## 6.3 构建期密钥：用 BuildKit secret，不要 `--build-arg`

`--build-arg` 传的密钥会**写进镜像历史**，`docker history` / 拉镜像的人都能看到；即便删了文件也在层里。正确做法是 BuildKit secret：**只在 RUN 期间挂载，不落层、不进 history**。

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=netrc,target=/root/.netrc \
    --mount=type=secret,id=token \
    make deps && rm -f /root/.netrc
```

```bash
docker buildx build \
  --secret id=netrc,src=$HOME/.netrc \
  --secret id=token,env=NPM_TOKEN \
  -t reg/app:test .
```

CI 里 `src` 换成 id（内容来自 `--secret id=token,env=...` 或 BuildKit secret provider），密钥**不落磁盘、不进 `--build-arg`、不写 Dockerfile**。对照着写一遍是今天 checklist 的必过项。

## 6.4 可复现构建：两次构建产出同一个 digest

「可复现」在本项目的具体含义是：**同一 commit + 同一构建参数 → 同一镜像 digest**。做不到全量复现时，至少锁死输入：

```dockerfile
# 基础镜像固定 digest，而不是浮动 tag
FROM golang:1.23-bookworm@sha256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx AS build
FROM gcr.io/distroless/static-debian12@sha256:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy:nonroot
```

三个常见的不确定源：

| 来源 | 症状 | 处理 |
|---|---|---|
| 浮动 tag | 昨天和今天 `alpine:3` 不是同一个层 | 固定到 `@sha256:`（`docker buildx imagetools inspect` 取 digest） |
| 时间戳 | 层里内嵌构建时间，digest 每次都变 | `SOURCE_DATE_EPOCH`，或构建器的时间戳重写选项（**随版本演进，以官方文档为准**） |
| 文件顺序 | `COPY` 目录顺序、`tar` 打包顺序不稳 | 明确排序；依赖安装用锁文件 `--frozen-lockfile` |

取基础镜像 digest 的可靠办法：

```bash
docker buildx imagetools inspect golang:1.23-bookworm --format '{{json .Manifest.Digest}}'
```

## 6.5 让构建产物能被多架构复用（Day 7 的接口）

今天的构建要留一个「可被 Day 7 复用」的形状：

- 构建**不写死平台**：镜像里不要嵌 `GOARCH=amd64` 之类的硬编码，交给 `--platform` 或 `TARGETARCH`。
- 用 `ARG TARGETARCH` 感知目标架构：

```dockerfile
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/app ./cmd/app
```

`$BUILDPLATFORM` / `$TARGETPLATFORM` / `$TARGETARCH` 是 BuildKit 预置的 ARG，恰是 Day 7 双架构构建的地基。今天先把构建写成「架构无关、由参数驱动」：**一个可复现的构建产物，明天才可能被两个架构复用同一套缓存。**

## 6.6 今天的判断力

- 看到 `-v /var/run/docker.sock`，先问「谁能触发这段脚本」。
- 看到密钥，先问「在 `history` 里能不能翻出来」。
- 看到浮动 tag，先问「上次构建和这次是不是同一个镜像」。
- 看到 `USER` 缺省，先问「容器里跑的是不是 root」。

下一模块：把这套构建升级成 **amd64/arm64 双轨发布**——本路径的重点。
