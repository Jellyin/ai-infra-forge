---
title: GitOps 与 ArgoCD 架构
---

# Day 12 · GitOps 与 ArgoCD 架构

## 12.1 为什么必须弃用 CI 里直接 `kubectl apply`

CI 里跑 `kubectl apply` 看起来最省事，但它把四个问题同时埋进系统里：

| 问题 | 具体表现 |
|---|---|
| **凭证** | CI 必须持有能操作 prod 集群的长期 kubeconfig/token。任何能改流水线的人，就等于拿到了 prod 的钥匙；CI 本身成了攻击面。 |
| **漂移** | apply 是**一次性 push**。之后有人 `kubectl edit` 热修，集群真实状态与 Git 悄悄分叉，没人知道，也没人会去纠正。 |
| **审计** | 「谁、在什么时候、把什么 apply 上去了」散落在流水线日志与集群里；脚本里的分支判断让真正生效的配置并不完整地存在于 Git。 |
| **不可复现** | 集群状态 = 数据库 + 集群 + 脚本共同决定，无法从 Git 重建。灾备时你复制不出第二个环境。 |

四条指向同一个根因：**真实状态由「动作」定义，而不是由「声明」定义**。GitOps 就是反过来——**Git 里的声明是唯一事实源，集群向它收敛**。

## 12.2 GitOps 四条原则

（OpenGitOps 定义）

1. **声明式**：期望状态以声明形式描述（K8s manifest）。
2. **版本化且不可变**：声明存于 Git，有历史、可回滚、可审计。
3. **自动拉取**：集群内的 agent **主动拉取**声明，而不是外部系统 push 进来。
4. **持续协调**：agent 持续比对期望与真实，发现偏差就收敛（或告警）。

**「拉」而非「推」是本节的杠杆点**：集群凭证不出集群，CI 不再需要 prod 的钥匙，漂移被持续检测。理解这一条，余下都是它之上补的工程细节。

## 12.3 ArgoCD 组件职责与常见故障点

| 组件 | 职责 | 常见故障点 |
|---|---|---|
| **API Server**（`argocd-server`） | 对外提供 REST/gRPC 与 UI/CLI 后端，处理 Application 的增删改查与鉴权 | OOM、证书、与 repo-server 通信失败；UI 卡住常与它或 Redis 有关 |
| **Repo Server**（`argocd-repo-server`） | 克隆 Git 仓库、渲染（Helm / Kustomize / plain）、缓存 | Git 凭证失效、Helm 渲染超时/OOM、缓存磁盘满。它无状态，可重启 |
| **Application Controller**（`argocd-application-controller`） | 核心大脑：watch Application，**对比 Git 期望与集群真实**，计算 sync/health，执行同步 | 与目标集群连接失败、内存与并发压力、单实例下的规模瓶颈 |
| **Redis**（`argocd-redis`） | controller 与 API server 之间的缓存/共享状态 | 挂了表现为 UI 显示陈旧或报错、状态不同步；可重建，不是事实源 |
| **Dex**（`argocd-dex-server`） | 可选 SSO，对接上游 OIDC/LDAP | SSO 回调、group 映射；不用 SSO 时可不部署 |

排障顺序建议：**先看 Application Controller（它决定同步）→ 再看 Repo Server（它决定能否渲染出期望）→ 再看 API Server / Redis（它决定你看到的界面）**。UI 不对不等于同步不对。

## 12.4 `Application` CR 与 sync policy

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/example/gitops.git
    targetRevision: main
    path: apps/myapp/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: myapp
  syncPolicy:
    automated:
      prune: true        # Git 删掉的资源，集群里也删
      selfHeal: true     # 集群被手动改，自动改回 Git 状态
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

三个开关的取舍：

- **自动 vs 手动**：写了 `automated` 就是「Git 合并即部署」；不写则是「已同步但待在制品/待批准」，适合 prod 的变更窗口。**先手动、后自动**是稳健的迁移路径。
- **`prune`**：把「删除」也交给 Git。危险在于**渲染出错生成空/缺失清单时会误删**；务必在无关紧要的环境先验证，并配合 `syncOptions: [PruneLast=true]`。它默认不处理「空清单清空整个应用」（`automated.allowEmpty` 默认 `false`）。
- **`selfHeal`**：让漂移自动收敛。它与「热修」天然冲突——**别人正在 `kubectl edit` 的应急处置会被反复改回**。

## 12.5 漂移检测与自愈：什么时候该自愈，什么时候只报警

漂移（drift）的典型来源：有人手动 `kubectl edit` / `scale`；其他控制器改写了字段（HPA 改 `replicas`、VPA 改 requests）；准入 webhook 注入了 sidecar/默认值。

- **该自愈的**：期望「对 Git 零妥协」的资源与环境——无状态服务、配置类资源、dev/staging。
- **只报警的**：① 有人正在进行应急处理时；② 字段本就由别的控制器管，自愈会「打架」。

对「打架」的字段，用 `ignoreDifferences` 让 ArgoCD 不去纠正：

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas      # 由 HPA 管理，不参与自愈
```

> 判断口径：**自愈只应用在「Git 一定是权威」的资源上**。凡是存在第二权威（HPA、Operator、人工应急）的字段，要么 `ignoreDifferences`，要么该环境只报警不自愈。

## 12.6 CI 与 CD 的职责边界

一句话：**CI 产出制品并提交声明，CD 从 Git 同步**。

```
开发者 push 源码
   │
   ▼
CI（GitLab CI / GitHub Actions）
   ├─ 构建镜像 → 推 registry
   ├─ 跑测试、安全扫描
   └─ 用机器人账号，把新镜像的不可变 digest 写进 GitOps 仓库（提交 / 开 PR）
   │
   ▼
Git（声明仓库）—— 唯一事实源
   │  ← ArgoCD 持续拉取
   ▼
ArgoCD 渲染 → 对比 → 同步到集群
```

要点：

- **CI 不碰集群**：它不持有 kubeconfig，只推制品、改 Git。凭证问题从根上消失。
- **用 digest，不用可变 tag**：`image: registry/app@sha256:...` 保证「部署的就是测试过的那份」。`:latest` 会让「审计」失去意义。
- **声明变更走 PR**：镜像升级是一次可评审的提交，diff 即发布内容，回滚 = revert 这个 commit。

GitHub Actions 同理：job 只负责 build + push + 提交声明，部署交给集群内的 ArgoCD 拉取。

## 12.7 今天要建立的判断力

- 看到 CI 里 `kubectl apply`，先问：**凭证从哪来、漂移谁管、能不能从 Git 重建**。
- 看到 Application，先问：**auto / prune / selfHeal 三开关各是开是关，依据是什么**。
- 看到漂移告警，先问：**这个字段有第二权威吗？该自愈还是只报警**。
- 看到「发布」，先看的是**一次 Git 提交**，而不是一条流水线日志。

下一模块：一个集群一套手写 Application 撑不过三个环境——用 ApplicationSet、AppProject 与 Sync Wave 把它规模化。
