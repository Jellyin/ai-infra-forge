---
title: 实验六 · 把「危险的构建」改成「可复现、不泄密的构建」
---

# 🧪 动手实验 · Day 6

> **目标**：不是学 Dockerfile 语法，而是**亲手把三种真实事故复现出来再修掉**——socket 绑定的越权、`--build-arg` 泄密、浮动 tag 的不可复现。
>
> 三档任选：**档位 A 真环境**（有 CI runner 且允许 privileged）／**档位 B 本地**（有 docker + buildx 即可）／**档位 C 纸上**（13 分钟，读日志下判断）。

---

## 档位 A · 真环境（有可跑 privileged 的 runner）

### 1. 复现 socket 绑定的越权

写一个**看起来无害**的 job，只挂 docker socket：

```yaml
prove-socket-is-root:
  tags: [privileged-runner]
  image: docker:27
  script:
    # 只挂 socket，就能读到宿主机内核信息与宿主文件系统
    - docker run --rm --privileged -v /:/host alpine cat /host/etc/hostname
```

**记录**：`cat` 出来的是**宿主机的 hostname**，而不是容器里的。这说明脚本已经能读宿主根文件系统——同一条路径即可 `chroot /host`。写下：**这段脚本上如果放的是外部 MR 的代码，后果是什么。**

| 观察项 | 你的记录 |
|---|---|
| 读到的 hostname 是宿主的吗 | |
| 这段脚本被外部 MR 触发时的爆炸半径 | |

### 2. 三种构建器跑同一份 Dockerfile，记耗时与特权

对同一个 `Dockerfile`（含一次 `apt-get` 安装）分别用 rootless BuildKit、Buildah、DinD 构建，各跑两遍：

| 构建器 | 首构建耗时 | 二次（命中缓存） | 需要 privileged？ |
|---|---|---|---|
| BuildKit rootless | | | 否 |
| Buildah | | | 否 |
| DinD | | | 是 |

**结论**：rootless 方案的收益不在速度，而在**不需要 privileged**——这直接决定你的 runner 是否要把宿主机暴露给所有 job。

---

## 档位 B · 本地（有 docker + buildx 即可）

### 1. 制造一次 `--build-arg` 泄密

```bash
mkdir -p secret-lab && cd secret-lab
cat > Dockerfile <<'EOF'
FROM alpine:3.20
ARG NPM_TOKEN
RUN echo "token=$NPM_TOKEN" > /tmp/t && wc -c /tmp/t && rm -f /tmp/t
EOF

docker build --build-arg NPM_TOKEN=super-secret-123 -t leak:demo .

# 关键：从历史里把它翻出来
docker history --no-trunc leak:demo | grep -i super-secret
```

**你会看到** `super-secret-123` 明晃晃出现在 history 里——即便文件被 `rm` 了。这就是 `--build-arg` 不能传密钥的原因。

### 2. 改成 BuildKit secret（不进 history）

```bash
cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM alpine:3.20
RUN --mount=type=secret,id=npm_token \
    TOKEN=$(cat /run/secrets/npm_token) && \
    echo "len=${#TOKEN}" && \
    echo "$TOKEN" > /tmp/t && wc -c /tmp/t && rm -f /tmp/t
EOF

echo -n 'super-secret-123' >/tmp/npm_token
docker buildx build --secret id=npm_token,src=/tmp/npm_token -t leak:fixed .

docker history --no-trunc leak:fixed | grep -i super-secret || echo "OK: 历史里没有密钥"
```

**记录**：第二次的 `grep` 是否为空？这即 checklist 的「把 --build-arg 传密钥改成 BuildKit secret」。

### 3. 证明浮动 tag 不可复现

```bash
docker buildx imagetools inspect alpine:3.20 --format '{{json .Manifest.Digest}}'
```

两次分别取 tag 与 digest，把 Dockerfile 改成 `FROM alpine:3.20@sha256:<上一步的 digest>` 再构建。

| 形态 | 基础镜像标识 | 下次会不会变 |
|---|---|---|
| `alpine:3.20` | tag | 上游一更新就变 |
| `alpine:3.20@sha256:...` | digest | 不变 |

**注意**：`--load` 只能加载**单一平台**的镜像；多平台构建必须走 `--push` 或 `--output type=oci`（Day 7 展开）。

---

## 档位 C · 纸上（13 分钟，读日志下判断）

下面是一次构建的**部分日志与 history**，找出至少 4 个问题。

```
$ docker build -t app:1 .
[+] Building ...
 => FROM node:20
 => RUN npm config set registry ... && echo "//registry:_authToken=${REG_TOKEN}" > .npmrc && npm ci
 => CMD ["node","server.js"]
 => exporting to image
$ docker history --no-trunc app:1
IMAGE  CREATED BY
sha256:...  |1 REG_TOKEN=ghp_XXXX CMD ["node","server.js"] # buildkit
sha256:...  |1 RUN /bin/sh -c npm config set registry ... # buildkit
sha256:...  |1 WORKDIR /app
sha256:...  |1 COPY . . # buildkit
```

<details><summary>对照答案（先写完再看）</summary>

1. **token 进了 history**：`REG_TOKEN=ghp_XXXX` 直接出现在层的创建命令里——`--build-arg`/环境变量把密钥写进了镜像。改成 `RUN --mount=type=secret`。
2. **基础镜像浮动**：`FROM node:20` 没有固定 digest，不可复现。改成 `node:20@sha256:...`。
3. **单阶段、末镜像带 root**：没有多阶段，最终镜像背着编译工具链；也没有 `USER`，以 root 运行。改成多阶段 + distroless/非 root。
4. **`.npmrc` 落进层**：写进镜像的认证配置会被下游所有人读到。用 secret 挂载，或在同一个 RUN 内删除且确认不进独立层。
5. （加分）**没有 `--mount=type=cache`**：`npm ci` 每次都从头下，缓存没被利用。

</details>

### 最后一问（写下，Day 7 回看）

如果明天要给这个镜像**加一个 arm64 版本**，今天这份 Dockerfile 里，**哪一行会挡住你**？为什么？

<details><summary>参考答案</summary>

`FROM node:20` 这类**未指定平台、纯 tag** 的写法会挡住你：多架构构建时每个平台要拉对应架构的基础镜像，浮动的 tag 无法保证两个架构取到「同一代」的基础层，也会让缓存无法按平台分键复用。正确起点是用 `--platform=$BUILDPLATFORM` 的构建阶段 + 明确的 `TARGETARCH`，为 Day 7 的双轨构建留好接口。
</details>
