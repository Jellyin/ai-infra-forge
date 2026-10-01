---
title: 实验十六 · 看懂你集群的 GPU 拓扑与碎片
---

# 🧪 动手实验 · Day 21

> **目标**：两个「看」的能力——看 GPU 拓扑（判断调度位置好不好）、看碎片分布（量化浪费）。纸上有拓扑图诊断题，真机有实测命令。
>
> 三档：**真机**（任意有 GPU 的机器/K8s）／**纸上**（拓扑图审计）。

---

## 档位真机

```bash
# 1. 看本机 GPU 拓扑（哪怕单卡机器也有输出，多卡最有价值）
nvidia-smi topo -m
# 读法：GPU0-GPU7 的交叉表——NV# = NVLink 直连（最好）、PIX = 同 PCIe 交换机、
#       SYS = 跨 NUMA/socket（机内最差）、NODE = 跨 NUMA
# 运维必背：一个 8 卡训练任务的 8 张卡理想情况应全在 NV# 域

# 2. K8s 里看 GPU 分配是否用了拓扑感知
kubectl get nodes -o json | jq '.items[] | {node: .metadata.name,
  gpus: .status.allocatable["nvidia.com/gpu"]}'
# GPU Operator 开拓扑感知后 node 上会有 nvidia.com/gpu.topology 类 label

# 3. 碎片量化（共享集群必做巡检）
kubectl get pods -A -o json | jq -r '
  [.items[] | select(.spec.containers[].resources.limits["nvidia.com/gpu"] != null)
   | {ns:.metadata.namespace, gpu:.spec.containers[0].resources.limits["nvidia.com/gpu"], node:.spec.nodeName}]
  | group_by(.node) | map({node:.[0].node, used: (map(.gpu|tonumber)|add)})
  | .[]' | head -20
# 对照每节点卡数 → 手算当前碎片率（哪些节点只剩 1-2 卡挂着小任务）
```

**记录**：① 本机拓扑表里 NV# 域覆盖几卡；② 集群「空卡多但凑不齐整机」的节点清单与碎片率。

## 档位纸上（拓扑审计）

一个 8 卡节点 `nvidia-smi topo -m` 摘录：

```
      GPU0 GPU1 GPU2 GPU3 GPU4 GPU5 GPU6 GPU7
GPU0   X   NV12 NV12 NV12 SYS  SYS  SYS  SYS
GPU1       X   NV12 NV12 SYS  SYS  SYS  SYS
GPU2           X   NV12 SYS  SYS  SYS  SYS
GPU3               X   SYS  SYS  SYS  SYS
GPU4                   X   NV12 NV12 NV12
...
```

**问题 1**：这机器的真实拓扑是什么？（提示：GPU0-3 一组、GPU4-7 一组）

<details><summary>对照</summary>

**两个 NVLink 域**：GPU0-3 互联（可能挂在一张 PCIe 交换机/socket）、GPU4-7 互联；组间 SYS（跨 socket）。这是双路服务器的典型形态（每 socket 挂 4 卡）。**8 卡任务调度到这机器，跨组通信必走 SYS——性能天花板就摆在这**。
</details>

**问题 2**：一个 TP=4 的任务要 4 卡，调度器选了 GPU0/1/2/6。评价并给出正确选法。

<details><summary>对照</summary>

GPU6 在另一个域——TP=4 的张量并行会被切成「3 卡 NVLink + 1 卡跨 SYS」，每步通信等待最慢链路，性能明显受损。正确选法：**GPU0-3 或 GPU4-7 同域 4 卡**。这就是拓扑感知调度器打分要做的事。
</details>

**问题 3**（碎片区治理设计）：集群 40 节点×8 卡，当前 300 卡空闲但 64 卡任务排队。分析原因并给三招。

<details><summary>对照</summary>

原因：300 空闲卡散布（碎片率≈1-32/300≈89%，最多 4 台整机是全空的）。
三招：① 池分离——32 卡以上任务走「整机池」（节点独占），小任务共享池；② 装箱策略改 binpacking（同节点填满再开新节点）；③ descheduler 定期迁移小 Pod 腾整机。紧急手段：人工 evict 2-3 个可中断小任务立刻凑齐。
</details>

---

## ✅ 实验完成清单

- [ ] 我能读 topo -m 的交叉表（NV#/PIX/SYS 各代表什么）
- [ ] 我算过一次集群碎片率
- [ ] 我知道 TP=4 的卡要同域、以及为什么训练装箱与 Web 相反
