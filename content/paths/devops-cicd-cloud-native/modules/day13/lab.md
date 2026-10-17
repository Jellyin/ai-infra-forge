---
title: 实验十三 · 把一套 Application 变成一条矩阵
---

# 🧪 动手实验 · Day 13

> **目标**：用 ApplicationSet、AppProject 与 Sync Wave，把「手写 N 份 Application」压成一套声明——并亲手验证「顺序依赖」与「谁能改什么」这两件事。
>
> 三档任选：**档位 A 真环境**（多集群 + ArgoCD）／**档位 B 本地**（`kind` + ArgoCD，用目录模拟多环境，无云可做）／**档位 C 纸上**（15 分钟，纯推理）。

---

## 档位 B · 本地（`kind` + ArgoCD，无云可做）

```bash
kind create cluster --name multienv
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd wait --for=condition=available --timeout=300s deploy --all
```

（清单与 CLI 随版本演进，**以官方文档为准**。）

### 1. 用目录结构声明环境矩阵

```bash
mkdir -p gitops/apps/demo/overlays/{dev,staging,prod} && cd gitops && git init -b main
```

在每个 `overlays/<env>` 里放一份最简 manifest，然后 push 到一个集群可访问的仓库（本地可用 `git daemon`，或用你自己的远端仓库）。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: demo
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
        namespace: 'demo-{{ index .path.segments 3 }}'
```

```bash
kubectl apply -f applicationset.yaml
kubectl -n argocd get applicationset,applications
```

| 观察项 | 你的记录 |
|---|---|
| 生成了几个 Application | |
| 新增一个 overlays 目录后，Application 是否自动出现 | |
| 删除一个目录后 | |

### 2. 用 Sync Wave 解决顺序依赖

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ordered
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: after-ns
  namespace: ordered
  annotations:
    argocd.argoproj.io/sync-wave: "0"
data:
  hello: world
```

观察：若把两者放进**同一个 wave**，ConfigMap 有可能先于 Namespace 应用而失败；加了 wave 后顺序被强制。**数字小者先执行。**

### 3. 用 AppProject 划边界

```bash
argocd proj create team-demo \
  --src https://github.com/example/gitops.git \
  --dest https://kubernetes.default.svc,demo-*
argocd proj list
```

尝试把 `team-demo` 允许范围之外的命名空间设为某个 Application 的目标，观察是否被 project 拒绝。

---

## 档位 A · 真环境（多集群）

在档位 B 基础上注册第二个集群，并用 `cluster` generator 按标签分发：

```bash
argocd cluster add staging-cluster
argocd cluster add prod-cluster
argocd cluster list
```

```yaml
  generators:
    - clusters:
        selector:
          matchLabels:
            env: prod
```

**验收**：给集群打上 `env` 标签后，Application 是否只被分发到匹配的集群；`argocd cluster add` 是否在目标集群创建了 `argocd-manager` 绑定（**它的权限就是 ArgoCD 的边界**）。

---

## 档位 C · 纸上（15 分钟，无需环境）

**场景**：一位工程师图省事，把数据库密码明文写进 GitOps 仓库的一个 `Secret` 清单里，理由是「反正仓库是私有的」。他还把「建表迁移 Job」和一个依赖新表的 Deployment 放在**同一个 sync wave**。上线时有时成功、有时报「表不存在」。

请回答：① 明文密钥有什么问题，你会怎么改？② 迁移 Job 该怎么放才对？③ 用什么机制保证迁移一定先于应用完成？

<details><summary>对照答案（先写完再看）</summary>

**① 明文进 Git 的问题**：Git 历史无法真正删除密钥，仓库读权限即密钥泄露面，无法追踪轮换。改法按取舍选：密钥真源在云/Vault → **External Secrets**（明文不进 Git）；单集群想 Git 化 → **Sealed Secrets**（密文可入 Git）；需要动态凭证 → **Vault** 路线。关键：**明文永不进 Git**。

**② 迁移 Job 的位置**：不该塞进 Deployment 的 initContainer（每次扩容都会跑），也不该和消费者同 wave。应作为 **`PreSync` hook**，让迁移在应用前完成；失败即阻断 sync。

**③ 保证顺序**：① 用 hook 类型 `PreSync`（不是靠 wave 的「尽量顺序」）；② 依赖 hook 失败会阻断 sync 这一特性；③ 迁移脚本必须**幂等**；④ 遵守 expand/contract，让迁移本身可回滚——hook 只解决顺序，不解决可回滚。

</details>

### 最后一问（写下你的答案）

你的项目要用哪种密钥方案？逐条写下取舍依据，**必须回答四个问题**：

| 问题 | 你的回答 |
|---|---|
| 密钥的真源在哪（Git / 云 Secret Manager / Vault） | |
| 是否多集群 | |
| 需要自动轮换吗 | |
| 能否接受密文进 Git | |

<details><summary>提示</summary>

四问的答案基本决定方案：真源在云/Vault 且多集群 → External Secrets；只要单集群、想全 Git 化 → Sealed Secrets；要动态短租期凭证 → Vault 集成。**没有「最好」的方案，只有与你的密钥真源和轮换需求匹配的方案。**
</details>
