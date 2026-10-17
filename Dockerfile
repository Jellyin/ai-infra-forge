# 多阶段构建：install → build → 极小运行时
# 构建期把 content/ 编译进静态产物（构建期内容加载架构），运行时零依赖。
#
# 基础镜像与 npm 源都做成可覆盖参数，默认走国内镜像源（daocloud）
#   NODE_IMAGE / NGINX_IMAGE  —— 基础镜像来源
#   NPM_REGISTRY              —— corepack 拉 pnpm 与 pnpm 装依赖都用它
# 需要改源时：优先改仓库根 .env（compose 自动读取），或在此处改默认值
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
ARG NGINX_IMAGE=docker.m.daocloud.io/library/nginx:alpine

FROM ${NODE_IMAGE} AS builder
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}

# pnpm via corepack（node 22 自带）
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# 先拷 workspace 清单 + lockfile，利用层缓存装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/logic/package.json packages/logic/
COPY packages/content-schema/package.json packages/content-schema/

# --frozen-lockfile：按 lockfile 的版本与 integrity 哈希精确安装，不重新解析版本
RUN pnpm install --frozen-lockfile --registry=${NPM_REGISTRY} \
      --filter web --filter @aiforge/logic --filter @aiforge/content-schema

# 源码与内容（内容变了只重建这一层之后）
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
COPY content content

RUN pnpm --filter web run build

# ---- 运行时：nginx 静态服务 ----
FROM ${NGINX_IMAGE}
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# 站点配置（SPA fallback + 长缓存 + 安全响应头）见仓库根目录 nginx.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
# 用 127.0.0.1 而不是 localhost：容器内 localhost 同时映射到 127.0.0.1 与 ::1，
# 而 nginx 这里只监听 IPv4，wget 先试 ::1 会被拒 → 健康检查永远失败。
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
