---
title: 实验十五 · 让 Git 与集群一字不差
---

# 🧪 动手实验 · Day 15

> **目标**：亲手走一遍「改清单 → 看 diff → 落地」，并制造三类**静默不一致**（digest 漂移、改 ConfigMap 不重启、探针误杀），再逐个修掉。
>
> 三档任选：**档位 A 真环境**（有集群 + ArgoCD）／**档位 B 本地**（`kind` + helm/kustomize CLI，无云也能做）／**档位 C 纸上**（读一份清单找 8 处误配）。

---

## 档位 A · 真环境（集群 + ArgoCD）

### 1. 制造一次「改 ConfigMap 不生效」

```bash
kubectl create configmap app-config --from-literal=mode=old -n demo
# 让 Deployment 通过 volume 挂载它，然后：
kubectl edit configmap app-config -n demo   # 把 mode 改成 new
kubectl exec deploy/api -n demo -- cat /etc/app/mode
```

**观察**：Pod 内文件内容**不会变**（除非挂了 subPath 且进程会重读），Pod 也没重启。这就是「改完不生效」——它不会报错，只会让你的新配置石沉大海。

记录修复前后的差异：

| 手段 | 集群里 pod template 的 annotation | 是否触发滚动 |
|---|---|---|
| 什么都不做 | 无变化 | 否 |
| 加 `checksum/config` 注解 | 内容哈希变化 | 是 |
| Kustomize `configMapGenerator` | ConfigMap 名带哈希后缀 | 是（引用名变化） |

### 2. 用 `kubectl diff` 做合并前预览

```bash
kustomize build overlays/prod | kubectl diff -f -
```

把输出**贴进合并请求**。重点看 `kubectl diff` 是否报 `images` 的 digest 变化——这是判断「这次合并会不会偷偷换镜像」的直接证据。

---

## 档位 B · 本地（无云，纯 CLI）

### 1. 用 base + overlay 渲染出两份清单并对比差异

```bash
mkdir -p lab/{base,overlays/dev,overlays/prod} && cd lab
# base：一份最小 Deployment + Service + kustomization
kustomize build overlays/dev > /tmp/dev.yaml
kustomize build overlays/prod > /tmp/prod.yaml
diff <(kubectl create --dry-run=client -f /tmp/dev.yaml -o yaml) \
     <(kubectl create --dry-run=client -f /tmp/prod.yaml -o yaml)
```

**判断标准**：理想情况下，两份清单的差异应当**只有你显式写在 overlay 里的那几处**（副本数、资源、镜像）。如果 diff 出来一堆你没写过的差异，说明差异没收敛到 overlay。

### 2. 校验与策略检查

```bash
# schema 校验（校验清单是否符合 K8s API schema）
kubeconform -strict overlays/prod/
# 渲染预览，防止模板渲染出空文档
helm template ./chart > /tmp/rendered.yaml && wc -l /tmp/rendered.yaml
```

| 工具 | 抓什么 | 抓不到什么 |
|---|---|---|
| `kubeconform` / `--dry-run=server` | 字段拼写、类型、缺必填 | 「合法但不该做」的事 |
| `kube-score` / Kyverno | 缺 limits、用 latest tag | 语义上的业务错误 |

### 3. 制造 digest 漂移

```bash
IMG=$(kubectl create --dry-run=client -f - -o jsonpath='{.spec.containers[0].image}' <<'YAML'
apiVersion: v1
kind: Pod
metadata: {name: x}
spec:
  containers: [{name: c, image: nginx:latest}]
YAML
)
echo "$IMG"   # 可变 tag
```

**关键结论**：`nginx:latest` 这份清单，今天 apply 和明天 apply 可能拉到**不同镜像**。改成 digest（`nginx@sha256:...`）后，清单才真正「钉死」。

---

## 档位 C · 纸上（12 分钟，无需环境）

下面这份 Deployment **有 8 处会导致「集群与 Git 不一致」或运行事故的误配**。先自己找，再看答案：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: api, namespace: prod}
spec:
  replicas: 3
  selector:
    matchLabels: {app: api}
  template:
    metadata:
      labels: {app: api}
    spec:
      containers:
        - name: api
          image: registry.example.com/api:latest
          livenessProbe:
            httpGet: {path: /healthz, port: 8080}   # 该接口内部会查数据库
          envFrom:
            - configMapRef: {name: app-config}      # 无 checksum 注解
```

<details><summary>对照答案（先写完再看）</summary>

1. **`image: ...:latest` 是可漂移 tag**：同一清单在不同时间 apply 可能拉到不同镜像。应用 digest 固定。
2. **没有 `readinessProbe`**：Pod 未就绪就开始接流量。
3. **没有 `startupProbe` 且 liveness 无 `initialDelaySeconds`**：慢启动时 liveness 可能在进程起来前就失败，反复重启（CrashLoop）。
4. **liveness 探的是依赖 DB 的 `/healthz`**：DB 一抖 → liveness 全挂 → 全部 Pod 被重启 → 雪崩。liveness 只应探进程自身；依赖检查放 readiness 或独立探针。
5. **没有 `resources.requests/limits`**：调度器按 0 资源塞 Pod，节点过度超卖；且无 memory limit，可能 OOM 整节点。
6. **`configMapRef` 无 `checksum/config` 注解**：改了 ConfigMap 不会触发滚动重启，新配置不生效。
7. **envFrom 挂 ConfigMap**（而非 volume）：env 注入的值在**容器启动时固定**，改 ConfigMap 后即便重启也不会重读，必须靠滚动重建。
8. **没有 PDB**：节点排空/升级时 3 个副本可能被一次性驱逐，可用性中断。

</details>

### 最后一问（写下你的答案）

如果你的 CI 允许「直接改 Git 里的 image tag 并自动合并」，你会在流程里**加哪一道门禁**，才能既拿到自动化的便利、又不让坏清单进集群？

<details><summary>参考答案</summary>

至少要求：① image **用 digest** 而非 tag，避免合并时是另一份镜像；② 合并前跑 `kubectl diff` 并把输出作为 MR 证据（人工确认「会变成什么」）；③ 分支保护 + 必过校验（schema 校验 + 策略检查）；④ 用 ArgoCD Image Updater 或专门的 CI job **而不是人工直接 push**，让「改 Git」这件事有单一入口、可审计。核心是：自动化改 Git 的前提是**改的内容必须过校验、必须可预览**。
</details>
