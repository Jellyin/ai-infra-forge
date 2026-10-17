---
title: ArgoCD 规模化：多环境、多集群与治理
---

# Day 13 · ArgoCD 规模化：多环境、多集群与治理

## 13.1 一个集群一套手写 Application 撑不过三个环境

手写 Application 的问题是**每加一个环境/集群就要复制并维护**（3×5 = 15 份近乎相同的 YAML）。规模化第一步：把「重复」交给生成器。

| 方式 | 是什么 | 适用 | 局限 |
|---|---|---|---|
| **App-of-Apps** | 父 Application 指向放满子 Application 的目录 | 少量应用、一眼看全 | 父子强耦合、粒度粗，扩环境仍要复制 |
| **ApplicationSet** | controller 用 generator 程序化生成 Application | 多环境/多集群、目录即矩阵 | 要理解 generator 与模板，调试成本高 |

边界：应用数 × 环境数用手指数不清就上 ApplicationSet；App-of-Apps 适合早期。

## 13.2 目录式生成：目录结构即环境矩阵

`git` generator 直接读仓库目录——**目录结构即环境矩阵**：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - git:
        repoURL: https://github.com/example/gitops.git
        revision: main
        directories:
          - path: apps/*/overlays/*
  template:
    metadata:
      name: '{{ index .path.segments 1 }}-{{ index .path.segments 3 }}'
    spec:
      project: default
      source:
        repoURL: https://github.com/example/gitops.git
        targetRevision: main
        path: '{{ .path.path }}'
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{ index .path.segments 1 }}-{{ index .path.segments 3 }}'
      syncPolicy:
        syncOptions:
          - CreateNamespace=true
```

**目录一加环境就出现、一删就回收**——矩阵就是仓库目录（语法随版本演进，**以官方文档为准**）。

## 13.3 多集群注册与权限隔离

```bash
argocd cluster add prod-cluster    # kubeconfig context 名
argocd cluster list
```

注册会在**目标集群**建 `argocd-manager` SA——**它的权限就是 ArgoCD 在该集群的边界**。`cluster` generator 可用标签选集群：

```yaml
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod
```

`destination.server` 指向具体集群；**权限按集群 + 命名空间分层**。

## 13.4 AppProject 与 RBAC：谁能看到、改到哪些应用

`AppProject` 是**隔离边界**：限定能用哪些仓库、部署到哪些集群/命名空间、允许哪些集群级资源。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
spec:
  sourceRepos:
    - https://github.com/example/payments-config.git
  destinations:
    - server: https://kubernetes.default.svc
      namespace: payments-*
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace
  roles:
    - name: developer
      policies:
        - 'p, proj:team-payments:developer, applications, get, team-payments/*, allow'
        - 'p, proj:team-payments:developer, applications, sync, team-payments/*, allow'
      groups:
        - payments-oidc-group
```

- **`sourceRepos` / `destinations` 是最有价值的两道墙**：团队 A 的 project 进不了团队 B 的命名空间。
- **`clusterResourceWhitelist` 默认空**：CRD、ClusterRole 等必须显式放行。
- 角色策略是 Casbin 语法、可绑 OIDC group；全局 RBAC 在 `argocd-rbac-cm/policy.csv`。**「谁能改哪些应用」= project roles ∩ 全局 policy。**

## 13.5 Sync Waves 与 Hooks：把依赖顺序讲清楚

**有依赖顺序**的资源要显式排序：用 `argocd.argoproj.io/sync-wave`，**数字小者先**（默认 0）：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "-1"    # 先建命名空间
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "0"     # 再建应用
```

**数据库迁移这类一次性任务用 hook**，而不是塞进 initContainer：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: myapp-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync                    # 应用前执行
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/myapp@sha256:REPLACE_ME   # 与本次发布同一 digest
          command: ["./migrate", "up"]
```

Hook 类型：`PreSync`/`Sync`/`PostSync`/`SyncFail`/`Skip`。**hook 失败会阻断整个 sync**——这正是迁移放 `PreSync` 的意义；迁移须**幂等**。金丝雀放量用 `AnalysisTemplate`：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result[0] >= 0.95
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{status!~"5.."}[1m]))
            /
            sum(rate(http_requests_total[1m]))
```

## 13.6 密钥进集群：三种方案的取舍

| 方案 | 机制 | 适合 | 代价 |
|---|---|---|---|
| **Sealed Secrets** | 公钥加密，**密文可入 Git**，集群内 controller 解密 | 单集群、想「密文也进 Git」 | 与集群绑定，跨集群迁移麻烦；轮换笨重 |
| **External Secrets**（ESO） | `ExternalSecret` CR 从外部密钥源**拉取** | 已有密钥源、多集群、需轮换 | 依赖外部系统可用性；要配 SecretStore |
| **Vault**（VSO / ESO 的 vault provider / AVP） | 直接以 Vault 为源，支持**动态凭证与租约** | 已用 Vault、要短期凭证 | 引入 Vault 运维与身份管道复杂度 |

取舍：真源在哪 / 多集群 / 要否轮换 / 能否密文进 Git → 云密钥源用 **ESO**、单集群全 Git 化用 **Sealed Secrets**、要动态短租期凭证用 **Vault**。

## 13.7 通知与审计：谁在什么时候同步了什么

**通知**：在 `argocd-notifications-cm` 定义 trigger/template/service，Application 上订阅：

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
    notifications.argoproj.io/subscribe.on-sync-failed.slack: deployments
```

**审计**两层：**Git 历史**记「期望为什么变」（author/时间/diff）；**`status.operationState`** 记「谁、哪 revision、何时、结果」。

## 13.8 今天要建立的判断力

- 看到重复 Application：**App-of-Apps 还是 ApplicationSet？**
- 看到新增环境：**加一个目录，还是又复制了一份 YAML？**
- 看到依赖顺序：**用 sync-wave，还是本该是一个 hook？**
- 看到密钥：**真源在哪、要不要轮换、能不能进 Git？**
