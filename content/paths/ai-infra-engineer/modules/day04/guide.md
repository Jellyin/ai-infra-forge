---
title: Kubernetes GPU 调度
---

# Day 4 · Kubernetes GPU 调度

## 4.1 GPU 进 K8s 的完整链路

你会 K8s，但 GPU 是「节点上的特殊资源」，要让它变成 K8s 可调度资源，需要一条链路：

```
NVIDIA Driver（节点层面，装好显卡驱动）
  └─ nvidia-container-toolkit（让容器能访问 GPU）
  └─ nvidia-device-plugin（DaemonSet，把 GPU 暴露成 nvidia.com/gpu 资源）
  └─ gpu-operator（Helm 一键装上面所有东西 + DCGM exporter）
```

**老运维最常卡的点**：驱动装好了，`nvidia-smi` 能跑，但容器里看不到 GPU。十有八九是 `nvidia-container-toolkit` 没装或没配 Docker runtime。

## 4.2 动手：用 GPU Operator 一键部署

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update
helm install --wait --generate-name \
  -n gpu-operator --create-namespace \
  nvidia/gpu-operator
```

**验证三件事**：

```bash
# 1. GPU 变成可调度资源（看到 nvidia.com/gpu: 8 之类）
kubectl get nodes -o json | jq '.items[].status.allocatable | {gpu: .["nvidia.com/gpu"]}'

# 2. 相关 DaemonSet 都 Running
kubectl get pods -n gpu-operator

# 3. 跑一个申请 GPU 的 Pod
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
spec:
  restartPolicy: Never
  containers:
  - name: cuda
    image: nvidia/cuda:12.4.0-base-ubuntu22.04
    command: ["nvidia-smi"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF
kubectl logs gpu-test
```

## 4.3 原生调度器不够用：为什么要 Volcano

原生 kube-scheduler 只认「节点有没有空闲 GPU」，但 AI 负载需要更多：

1. **Gang Scheduling（协同调度）**：分布式训练/大模型推理要「要么 8 卡一起上，要么一个都别上」。原生调度器可能调度了 7 个 Pod 卡住等第 8 个，浪费整机。
2. **队列配额**：多租户/多团队要按配额分配 GPU，有优先级抢占。
3. **拓扑感知**：优先把 Pod 调度到 NVLink 互联的卡上。

**Volcano**（CNCF 项目）解决这些问题。关键概念：

| 概念 | 作用 |
|------|------|
| PodGroup | 一组要一起调度的 Pod，minMember 语义 |
| Queue | 资源队列，配额 + 权重 + 优先级 |
| Gang Scheduling | 全有或全无调度 |
| 抢占 | 高优先级任务抢占低优先级 |

**动手（可选）**：

```bash
# 装 Volcano
kubectl apply -f https://raw.githubusercontent.com/volcano-sh/volcano/master/installer/volcano-development.yaml

# 起一个需要 gang 调度的测试 Job
```

## 4.4 MIG 在 K8s 里的体现

开启 MIG 后，`nvidia.com/gpu` 会细分出 `nvidia.com/mig-1g.10gb`、`nvidia.com/mig-2g.20gb` 这类资源。多租户平台就是让不同租户申请不同粒度的 MIG 资源。

**动手**：在 GPU Operator 里配置 MIG 策略，重启节点，观察资源变化。

## 4.5 碎片化问题（老运维的新坑）

**场景**：8 卡节点，8 个小 Pod 各占 1 卡，大模型 Pod 需要 8 卡整机，永远调度不上——这就是 **GPU 碎片化**。

**解法**：
- Volcano gang scheduling（保证整机分配）。
- 节点池隔离（大模型专用整机池 + 小模型共享池）。
- Karpenter 按机型动态拉起整机节点。

**面试答案**：GPU 调度最核心的挑战不是「有没有卡」，而是「碎片化导致整机凑不齐」。这是传统 CPU 调度没有的复杂度。

## 4.6 今日作业

在测试集群里：① 用 GPU Operator 装好 GPU 栈；② 跑通一个申请 GPU 的 Pod；③ 尝试 MIG 切分并观察资源变化；④ 想清楚一个多租户 MaaS 平台该怎么规划 GPU 池（整机池 vs 共享池）。

---
