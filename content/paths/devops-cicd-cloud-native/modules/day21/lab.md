---
title: 实验二十一 · 一次完整的「发布 → 观测 → 回滚」演练
---

# 🧪 动手实验 · Day 21

> **目标**：把「回滚」从纸面技能变成**肌肉记忆**——真的发布一个坏版本、真的观测到它坏了、真的回滚并**计时**。这是二十天里唯一一次**以时间为度量**的实验。
>
> 三档任选：**档位 A 真环境**（有集群 + ArgoCD/Rollouts）／**档位 B 本地**（kind 本地集群，完整演练）／**档位 C 纸上**（25 分钟，评审一份上线计划）。

---

## 档位 A · 真环境（有集群、最好有 ArgoCD + Argo Rollouts）

### 1. 选一个非核心服务，走一遍受控演练

```bash
# 记录「决定回滚」前的版本
kubectl rollout history deployment/<service>

# 触发一次坏发布（换一个不存在的 tag，或改坏探针）
kubectl set image deployment/<service> <container>=<repo>:<broken-tag>
```

用**观测**确认它真的坏了（而不是靠猜）：看错误率 / `burn rate`（Day 20）、看 pod 事件。然后回滚并**计时**：

```bash
time kubectl rollout undo deployment/<service>
kubectl rollout status deployment/<service>
# Argo Rollouts 场景：
# kubectl argo rollouts undo rollout/<service>
# GitOps 场景：
# argocd app history <app> ; argocd app rollback <app> <REVISION>
```

### 2. 填这张演练记录表（这是本实验的产物）

| 步骤 | 起点时间 | 完成时间 | 结果 | 备注 |
|---|---|---|---|---|
| 决定回滚 | | | | 谁做的决定？依据什么信号？ |
| 执行回滚 | | | | 命令是否一次成功？ |
| 用户恢复（SLO 曲线回落） | | | | **总耗时（MTTR）** |
| 数据一致性核验 | | | | 迁移可逆吗？ |

### 3. 故障注入一次

```bash
kubectl delete pod -l app=<service>          # 验证自愈与副本下限
# 或注入延迟/断依赖（需 chaos mesh 等，视集群能力）
```

**判据**：故障注入的价值不在「服务没挂」，而在**验证指标能否发现它、回滚/自愈是否会触发**。

---

## 档位 B · 本地（kind，完整「发布 → 观测 → 回滚」演练）

### 1. 起一个本地集群并发布 v1

```bash
kind create cluster --name rehearse
kubectl create deployment web --image=nginx:1.25 --replicas=3
kubectl rollout status deployment/web
kubectl get pods -l app=web
```

### 2. 制造一次坏发布

```bash
# 换成一个不存在的镜像 tag —— 会进入 ImagePullBackOff
kubectl set image deployment/web nginx=nginx:does-not-exist
kubectl get pods -l app=web -w      # 观察卡在 ImagePullBackOff（Ctrl-C 退出）
```

**观测**（本地无 Prometheus 时，用集群状态当信号）：

```bash
kubectl rollout status deployment/web   # 不会成功 —— 这就是「发布失败」的信号
kubectl describe pod -l app=web | tail -20
```

### 3. 回滚并计时（核心）

```bash
time kubectl rollout undo deployment/web
kubectl rollout status deployment/web
kubectl get pods -l app=web
```

| 你的观察 | 结论 |
|---|---|
| `rollout undo` 后 pod 回到 `Running` | 回滚路径可用 |
| 用时（秒） | 这就是你的**本地 MTTR 基线** |
| `rollout history` 里出现新 revision | 每次 undo 也是一次新 revision，历史可追溯 |

```bash
kubectl rollout history deployment/web   # 确认 revision 链
```

### 4. 把回滚做成脚本（肌肉记忆的固化）

```bash
cat > rollback.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
DEPLOY=${1:?用法: ./rollback.sh <deployment>}
echo "== 回滚前的历史 =="; kubectl rollout history deployment/"$DEPLOY"
time kubectl rollout undo deployment/"$DEPLOY"
kubectl rollout status deployment/"$DEPLOY" --timeout=60s
echo "== 回滚后 =="; kubectl get pods -l app="$DEPLOY"
SH
chmod +x rollback.sh && ./rollback.sh web
```

> 注：kind 默认**不含 metrics-server**，因此 `kubectl top pods` 不可用；容量观测可另装 metrics-server，或先以 `requests`/`limits` 与事件为准。

---

## 档位 C · 纸上（25 分钟，无需任何环境）

下面是某团队为一次「数据库 schema 变更 + 服务升级」写的上线计划。请评审：**哪几项缺失或不可校验**？给出你会在发布前追问的三个问题。

```
上线计划 v1（orders-api）
1. 代码已合并到 main
2. 跑完整 CI，绿灯即发布
3. 变更内容：给 orders 表新增非空列 payment_method，默认 'unknown'
4. 部署方式：kubectl set image 直接更新生产 Deployment
5. 若出问题：手动改回上一个镜像 tag
6. 值班：发布人自己
```

<details><summary>对照答案（先写完再看）</summary>

**缺失 / 不可校验的点**：
1. **制品不可验证**：「跑完整 CI」不等于制品已签名、可验签、digest 与部署清单一致——缺供应链门禁。
2. **无错误预算检查**：没有「发布前查 burn rate / 剩余预算」这一步。
3. **迁移不可逆风险未评估**：给已有表加**非空列**且旧代码不认识它，回滚代码后新列仍在，可能引发写入不兼容——**回滚不只是换镜像**。
4. **回滚方式太粗**：「手动改回上一个镜像 tag」没有命令、没有演练、没有时限，且**绕过 GitOps**（生产与 Git 漂移）。
5. **无观测判定**：没有说明发布后看什么信号、多久判定成功。
6. **无容量/成本**：新列与迁移对 DB 容量、连接数的影响未评估。
7. **值班不充分**：「发布人自己」缺少 oncall 与 runbook。

**该追问的三个问题（示例）**：
- 这次变更**回滚时数据库怎么办**？加列是否向后兼容（新旧代码都能读写）？
- 发布后**看哪个 SLI、什么阈值算成功、多久判定**？
- 出了事**谁在几分钟内执行回滚**，命令是什么，演练过吗？

</details>

### 最后一问（写下你的答案）

回看这次演练：从「决定回滚」到「用户恢复」，**卡在哪一步最久**？如果只能加固一个环节，你选**回滚演练**、**观测可信**、还是**自动门禁**——为什么？（提示：见 guide 21.5 的加固顺序。）
