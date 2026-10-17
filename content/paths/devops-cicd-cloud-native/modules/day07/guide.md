---
title: 多架构镜像：amd64 / arm64 双轨构建与发布
---

# Day 7 · 多架构镜像：amd64 / arm64 双轨构建与发布

## 7.1 为什么必须多架构：架构错配是「现在正在发生」的故障

| 场景 | 现象 |
|---|---|
| 开发机是 Apple Silicon（arm64） | `docker run` 拉 amd64 镜像 → 走 QEMU 模拟，慢、偶发崩溃、`exec format error` |
| 生产节点是 AWS Graviton / Ampere（arm64） | 集群只有 arm64，你的镜像是 amd64 → **直接起不来**，或调度后被 image 不匹配挡下 |
| CI runner 与生产架构不一致 | CI 里测过的镜像是 amd64，跑在生产 arm64 上——**测的和上的不是同一个二进制** |

**只产 amd64 的流水线在 arm64 集群上发布缺可信验证**（Day 1「假绿灯」同源）——要一次产出多架构。

## 7.2 两条路线：QEMU 模拟 vs 原生 arm64 runner

| 维度 | QEMU 模拟（单机跨架构） | 原生 arm64 runner |
|---|---|---|
| 原理 | 用 binfmt_misc + QEMU 在 amd64 上**模拟** arm64 指令 | 真在 arm64 CPU 上编译 |
| 编译型语言 | **慢**，常见 5–20×（Rust/C++/重编译依赖尤甚） | 原生速度 |
| 装配 | 简单：装一次 binfmt 即可，单机可做 | 需要一个 arm64 runner（自建/托管） |
| 成本 | 省 runner，费时间（占着 amd64 机器空跑） | 托管 arm64 runner 有单价；自建 Graviton/Ampere 通常更便宜 |
| 适用 | 小镜像、解释型语言、验证/兜底 | 大镜像、编译密集、要控制 wall-clock |

**装 QEMU binfmt（需 privileged）：**

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
docker run --rm --platform linux/arm64 alpine uname -m   # 应打印 aarch64
```

**交叉编译绕开 QEMU**：构建阶段用 `$BUILDPLATFORM` 交叉编译，只在运行阶段用 QEMU 装配层：

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/app ./cmd/app

FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER 65532:65532
ENTRYPOINT ["/app"]
```

**「QEMU 太慢」往往慢在没做交叉编译的 Dockerfile。**

## 7.3 一步到位：`buildx build --platform` 与推送

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$REG/app:1.0.0" \
  --push \
  .
```

- `--platform` 逗号分隔多平台 → 产出 **manifest list / OCI index**，一个 tag 指向多架构。
- **`--load` 不能加载多平台镜像**；多平台须 `--push`，或 `--output type=oci,dest=image.tar`。

**Buildah 做法**（rootless）：

```bash
buildah manifest create app:1.0.0
for arch in amd64 arm64; do
  buildah build --platform "linux/$arch" --manifest app:1.0.0 -t "app:1.0.0-$arch" .done
buildah manifest push --all app:1.0.0 "docker://$REG/app:1.0.0"
```

## 7.4 manifest list / OCI index：一个 tag，多个架构

`docker pull` 读 **index** 并按架构挑 manifest；**index 应含每个声明的平台、各有独立 digest**。

```bash
docker manifest inspect "$REG/app:1.0.0"          # 各平台 manifest
docker buildx imagetools inspect "$REG/app:1.0.0" # 更友好
```

```bash
# 顶层 index digest
docker buildx imagetools inspect "$REG/app:1.0.0" --format '{{json .Manifest.Digest}}'

# 各架构子 manifest 的 digest
docker buildx imagetools inspect "$REG/app:1.0.0" --format '{{json .Manifest}}' | jq '.manifests[] | {platform:.platform, digest:.digest}'
```

## 7.5 多架构的缓存与并行

- **缓存按平台分键**：不同架构层不同，不能共用；平台写进 registry 缓存 ref：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --cache-from "type=registry,ref=$REG/app:cache" \
  --cache-to   "type=registry,ref=$REG/app:cache,mode=max" \
  -t "$REG/app:1.0.0" --push .
```

```yaml
--cache-to "type=registry,ref=$REG/app:cache:$CI_COMMIT_REF_SLUG-$ARCH,mode=max"
```

- **并行扇出**：**每架构在自己的原生 runner 上并行构建，最后合并成一个 index**（matrix 扇出）。

### GitLab CI

```yaml
stages: [build, manifest]

build:arch:
  stage: build
  parallel:
    matrix:
      - ARCH: [amd64, arm64]
  tags: ["runner-$ARCH"]   # 按 ARCH 选 runner
  image: docker:27
  script:
    - docker buildx create --use --name b-$ARCH
    - docker buildx build
        --platform "linux/$ARCH"
        --cache-from "type=registry,ref=$CI_REGISTRY_IMAGE/cache:$CI_COMMIT_REF_SLUG-$ARCH"
        --cache-to   "type=registry,ref=$CI_REGISTRY_IMAGE/cache:$CI_COMMIT_REF_SLUG-$ARCH,mode=max"
        -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-$ARCH" --push .

manifest:merge:
  stage: manifest
  image: docker:27
  needs: ["build:arch"]
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker buildx imagetools create
        -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
        "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-amd64"
        "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-arm64"
```

### GitHub Actions

```yaml
jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: linux/amd64
            runner: ubuntu-24.04
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: ${{ matrix.platform }}
          push: true
          tags: ${{ vars.REG }}/app:${{ github.sha }}-${{ matrix.platform == 'linux/amd64' && 'amd64' || 'arm64' }}
```

## 7.6 双架构的测试与验证：不能只测 amd64

**只跑 amd64＝只验证一半。** 至少补：

1. **架构断言**：`docker run --rm --platform linux/arm64 img uname -m` 得 `aarch64`。
2. **冒烟测试**：arm64 上真跑起来（原生扩展最易翻车）。
3. **index 完整性**：`imagetools inspect` 断言两平台都在。
4. **digest 一致性**：晋升与部署拉取须为**同一 index digest**。

## 7.7 晋升与回滚：引用 index digest，不引用单架构 digest

**`amd64` 镜像的 digest 和 index 的 digest 是两回事。**

```bash
# 单架构 digest
docker buildx imagetools inspect "$REG/app:1.0.0-amd64" --format '{{json .Manifest.Digest}}'

# index digest（覆盖两架构）
docker buildx imagetools inspect "$REG/app:1.0.0" --format '{{json .Manifest.Digest}}'
```

- 晋升与回滚**按 index digest 固定**（`app@sha256:<index-digest>`）。
- 引用**单架构 digest**，arm64 节点会拿到 amd64 那份——最难查。
- **回滚**只需指回上一版 index digest，一次覆盖两架构。

```bash
# 用 index digest 精确回滚
kubectl set image deploy/app app="$REG/app@sha256:<上一个 index digest>"
kubectl rollout status deploy/app
```

## 7.8 今天的判断力

- amd64 镜像跑在 Graviton 上，先问「CI 测的和生产的是同一个二进制吗」。
- QEMU 慢，先问「Dockerfile 做交叉编译了吗」。
- 晋升引用 `amd64` digest 判红——**多架构制品永远引用 index digest**。
- 「双架构发布」，追问 index 是否**真**有两个平台、都**测过**。
