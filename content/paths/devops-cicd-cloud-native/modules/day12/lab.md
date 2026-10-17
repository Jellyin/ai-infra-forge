---
title: 实验十二 · 让 Git 成为唯一事实源
---

# 🧪 动手实验 · Day 12

> **目标**：亲手跑通一条 GitOps 链路（Git → ArgoCD → 集群），再制造一次漂移，看清「自愈」和「只报警」的区别。你如果是老 DevOps，一定见过 CI 里 `kubectl apply` 留下的烂摊子——本实验把它换掉。
>
> 三档任选：**档位 A 真环境**（有 K8s 集群 + 已装 ArgoCD）／**档位 B 本地**（一条命令起 `kind` + 本地装 ArgoCD，无云可做）／**档位 C 纸上**（15 分钟，纯推理）。

---

## 档位 B · 本地一键起（推荐先从这里开始，无云可做）

```bash
# 1) 起一个本地集群
kind create cluster --name gitops

# 2) 安装 ArgoCD（官方 stable 清单，可能随官方演进；“stable” 指向稳定分支）
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3) 等组件就绪
kubectl -n argocd wait --for=condition=available --timeout=300s deploy --all

# 4) 取初始 admin 密码（二选一）
argocd admin initial-password -n argocd
# 或
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d

# 5) 端口转发 + 登录
kubectl -n argocd port-forward svc/argocd-server 8080:443 &
argocd login localhost:8080 --username admin --password <上一步的密码> --insecure
```

> ArgoCD CLI 的子命令随版本演进，拿不准先看 `argocd --help` / `argocd app --help`，**以官方文档为准**。

### 1. 声明一个 Application，让 ArgoCD 去拉

```bash
argocd app create guestbook \
  --repo https://github.com/argoproj/argocd-example-apps.git \
  --path guestbook \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace guestbook \
  --sync-policy manual          # 先手动，观察差异后再开自动
```

```bash
argocd app get guestbook     # 看 Sync Status / Health Status
argocd app diff guestbook    # 看期望与真实的差异
argocd app sync guestbook    # 手动同步
```

| 观察项 | 你的记录 |
|---|---|
| sync 前 `app get` 的 Sync Status | |
| `app diff` 输出了什么 | |
| sync 后目标 ns 里出现了哪些资源 | |

### 2. 制造一次漂移，对比「自愈」与「只报警」

```bash
# 手动改集群里的 replicas —— 这就是一次「热修」
kubectl -n guestbook scale deploy guestbook-ui --replicas=5
argocd app get guestbook      # 观察 Sync Status 是否变为 OutOfSync
```

**关键观察**：手动（未开 `automated`）时，ArgoCD **只报告不同步、不会自动改回**。现在打开自愈再试：

```bash
argocd app set guestbook --sync-policy automated
```

再次手动 scale，观察资源是否被自动改回声明值。

> 结论：**自愈是「对 Git 零妥协」的工具**。若某个字段由 HPA 等其他控制器管理，自愈会与它反复打架——那时应改用 `ignoreDifferences` 或只报警。

---

## 档位 A · 真环境（有 K8s 集群 + ArgoCD）

在真实集群上重复档位 B 的步骤，并额外做一件事：**把 CI 从「直接 apply」改成「提交声明」**。

1. 建一个 GitOps 声明仓库，放 `apps/<app>/<env>/`。
2. CI 只做两件事：构建并推送镜像（记录 **digest**）、把 digest 写进声明仓库并开 PR。
3. ArgoCD 指向声明仓库，从 Git 同步。

**验收**：CI 的凭证里**不再有 kubeconfig**，镜像升级是一次可评审的 Git 提交。

---

## 档位 C · 纸上（15 分钟，无需环境）

**场景**：一条流水线在 `deploy` 阶段跑 `kubectl apply -f k8s/`。CI 变量里存着 prod 集群的 kubeconfig。上周二，一位 SRE 为救火手动把 prod 的副本数从 3 改到 10；本周一又一次发布，副本数被流水线「打回」3，容量骤降引发告警。没人记得谁在什么时候动过集群。

请回答：① 这次容量事故的根因属于「漂移」还是「凭证」？② 换成 GitOps 后，这类事故会如何被避免？③ 那位 SRE 的应急需求该怎么办才不冲突？

<details><summary>对照答案（先写完再看）</summary>

**① 根因是漂移**。集群真实状态被手工改写，却没有任何机制记录或纠正它；下次 apply 会「拉回」声明值，但没人知道曾经偏离过——事故是静默积累的。它也暴露了凭证问题（CI 持有 prod 钥匙），但触发点是漂移。

**② GitOps 后**：ArgoCD 持续比对，SRE 那次 `scale` 会立刻显示为 **OutOfSync**（若该字段由 HPA 管理则应 `ignoreDifferences`）。关键差别是：**偏离不再静默**。期望状态始终由 Git 定义，任何人看到的都是同一张图。

**③ 应急需求**：临时热修要么走 `ignoreDifferences` 明确「这段由人/别的控制器管」，要么通过一个紧急变更把期望写回 Git（可审计、可回滚）。**不要既信任自愈、又指望热修能存活**——两者在同一个字段上必然打架。

</details>

### 最后一问（写下你的答案）

对你的一个真实应用：**哪些字段应该交给 selfHeal，哪些必须 `ignoreDifferences`**？逐条写理由（提示：凡是存在「第二权威」——HPA、Operator、运维应急——的字段，就不该无条件自愈）：

| 字段/资源 | 自愈 or 忽略 | 理由（谁是第二权威） |
|---|---|---|
| | | |
| | | |

<details><summary>提示</summary>

常见答：`Deployment.spec.replicas` 若由 HPA 管理 → 忽略；`Service.spec.selector` / `ConfigMap.data`（无第二权威）→ 自愈；`Secret` 若由 External Secrets 同步 → 忽略（由外部系统写）。判断标准恒为：**这个字段的权威是 Git 还是别人**。
</details>
