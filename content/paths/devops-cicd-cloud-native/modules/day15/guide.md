---
title: 清单工程化与发布一致性
---

# Day 15 · 清单工程化与发布一致性

## 15.1 目标：Git 里写的 == 集群里跑的

保证一致性别靠肉眼比对，靠三件事：**清单唯一来源（Git）、镜像 digest 钉死、合并前能预览 diff**。

## 15.2 Helm 与 Kustomize：模板化 vs 叠加

| 维度 | Helm | Kustomize |
|---|---|---|
| 机制 | **模板化**：占位 `{{ }}` + values | **叠加**：base + overlay，纯 YAML |
| 学习成本 | 高（模板语法、release 生命周期） | 低（会 patch 即可） |
| 表达能力 | 强（条件、循环、helper） | 中（patch 类型有限但够用） |
| 可读性 | 差（要 `helm template` 才看真容） | 好（接近最终 YAML） |
| 陷阱 | values 覆盖难追踪、模板逻辑藏 bug | patch 写错可能静默不生效 |

选型：**一套模板产出差很大的多套清单**用 Helm；**同一套 base 微调环境差异**用 Kustomize。二者不互斥，可 Kustomize 包住 Helm chart。代价：模板化「渲染才知道结果」；叠加的 patch 匹配不到资源时不报错。

## 15.3 overlay 组织与环境差异最小化

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: resources-patch.yaml
    target: {kind: Deployment, name: api}
images:
  - name: registry.example.com/api
    newTag: sha-abc1234
```

目录约定：`base/` 放公共清单，`overlays/{dev,prod}/` 只放与 base 的差异（副本数、资源、镜像、少量 env）。**能靠 base 表达的一律下沉到 base**——差异越多越容易「dev 测过、prod 是另一份」。反模式是把 prod 的 Deployment 复制一份再改，那是 fork 不是 overlay。

## 15.4 镜像 digest 进清单：两条路

可变 tag（如 `latest`）是一致性头号敌人：同一清单不同时间 apply 可能拉到不同镜像。钉死用 digest。

| | CI 提交变更 | ArgoCD Image Updater |
|---|---|---|
| 谁改 Git | CI job 改 manifest 并 push | Image Updater 监听 registry 回写 Git |
| 优点 | 全程在 CI、审计清晰 | CI 不改仓库；支持 tag 正则自动跟版 |
| 缺点 | CI 需写权限；提交噪音多 | 需单独组件；写权限同样要给 |

```yaml
images:
  - name: registry.example.com/api
    digest: sha256:0d1e...cafe   # 与 newTag 二选一，digest 更抗漂移
```

**共同前提：分支保护 + 变更必须过校验**，否则「自动改 Git」= 「自动把坏清单合并进去」。

## 15.5 ConfigMap/Secret 变更后的热更新与重启

**改了 ConfigMap，正在运行的 Pod 不会自动读到新值**（env 注入的值在容器启动时固定），必须显式触发滚动重启。主流做法是 **checksum 注解**：把内容哈希写进 pod template 的 annotation，内容变 → annotation 变 → 触发滚动。

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: '{{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}'
```

Kustomize 等价做法用 `configMapGenerator`——自动给 ConfigMap 名加内容哈希后缀，name 变则引用变，同样触发滚动（代价是名字带哈希，别硬编码）。Secret 可用 Reloader 之类控制器或同样用 checksum。**别用「改完重启一下」的手工流程**——它一定会被忘记。

## 15.6 探针、requests/limits、PDB

| 探针 | 问什么 | 失败后果 | 常见误配 |
|---|---|---|---|
| `livenessProbe` | 进程还活着吗 | **重启容器** | 探活依赖下游（DB 挂→全线重启雪崩） |
| `readinessProbe` | 能接流量吗 | 摘除流量，不重启 | 没配 → 流量打到未就绪 Pod |
| `startupProbe` | 启动完成了吗 | 启动期禁用 liveness | 慢启动没配 → liveness 误杀 |

```yaml
      startupProbe: {httpGet: {path: /healthz, port: 8080}}   # 慢启动兜底
      livenessProbe: {httpGet: {path: /livez, port: 8080}}    # 只探进程自身
      readinessProbe: {httpGet: {path: /readyz, port: 8080}}  # 依赖检查放这里
```

要点：**liveness 只探进程本身，绝不探下游**；依赖检查放 readiness（失败只摘流量不重启）。**requests 全缺**会让调度器过卖；**CPU 通常不设 limit**（可压缩），**memory limit 必设**（不可压缩，没有会 OOM 整节点）。

PDB 管**自愿中断**（排空、滚动升级），不防宕机：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: api-pdb}
spec:
  maxUnavailable: 1        # 或 minAvailable（二者选一）
  selector:
    matchLabels: {app: api}
```

**最常见误配**：`minAvailable` 等于总副本数 → 任何节点都无法排空、`kubectl drain` 永远卡住。要留出可中断余量。

## 15.7 清单校验：四道防线

1. **schema 校验**：`kubectl apply --dry-run=server` / Kubeconform——抓字段拼写、类型。
2. **策略检查**：Kyverno/kube-score——抓「合法但不该做」（缺 limits、用 latest）。
3. **dry-run 渲染**：`helm template`/`kustomize build`——防渲染出空文档。
4. **diff 预览**：

```bash
kustomize build overlays/prod | kubectl diff -f -
```

`kubectl diff` 输出服务端最终会变成的样子，是一致性最直接的证据；放 CI 并要求人工确认。

## 15.8 今天要建立的判断力

- 多环境清单：**差异收在 overlay 里，还是被复制成了两份？**
- 镜像引用：**可变 tag 还是 digest？**
- ConfigMap：**改了它，怎么触发重启？**
- 探针：**liveness 有没有误探下游？**
- 合并前：**diff 预览过了吗？**
