# 多阶段构建：install → build → 极小运行时
# 构建期把 content/ 编译进静态产物（构建期内容加载架构），运行时零依赖。

FROM node:22-alpine AS builder
WORKDIR /app

# pnpm via corepack（node 22 自带）
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# 先拷 workspace 清单，利用层缓存装依赖
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/logic/package.json packages/logic/
COPY packages/content-schema/package.json packages/content-schema/

RUN pnpm install --frozen-lockfile=false --filter web --filter @aiforge/logic --filter @aiforge/content-schema

# 源码与内容（内容变了只重建这一层之后）
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
COPY content content

RUN pnpm --filter web run build

# ---- 运行时：nginx 静态服务 ----
FROM nginx:alpine
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# SPA fallback（当前是单页 hash 导航，仍配上以备未来路由）+ 长缓存静态资源
RUN printf 'server {\n\
  listen 80;\n\
  server_name _;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  gzip on;\n\
  gzip_types text/css application/javascript application/json image/svg+xml;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
  location /assets/ {\n\
    add_header Cache-Control "public, max-age=31536000, immutable";\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null || exit 1
