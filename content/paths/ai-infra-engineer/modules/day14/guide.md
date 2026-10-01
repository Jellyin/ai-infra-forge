---
title: 训练数据管道与存储
---

# Day 14 · 训练数据管道与存储

> 目标：数据集的吞吐设计——存储是训练的第一瓶颈

## 反直觉事实：训练慢的第一嫌疑是「GPU 饿了」

大模型训练的显性故障是 hang/OOM，**隐形故障是数据管道喂不上 GPU**——GPU 算得飞快但利用率呈「锯齿」（算-等-算-等）。万卡集群上，数据吞吐设计直接决定 MFU 上限。

## 数据加载三级流水

```
存储层（S3/并行文件系统） →  加载器（DataLoader/num_workers）  →  GPU
        ↑ 最慢的一环             ↑ 预取/解码/打散                ↑ 最快
```

瓶颈永远在最慢环。诊断顺序：
1. **GPU 利用率锯齿**（DCGM 看 SM util 周期性掉零）→ 数据喂不上
2. `iostat -x 1` 看 IO wait / 吞吐 → 存储层是否到顶
3. DataLoader 的 num_workers 是否太少（CPU 解码/预处理跟不上）

## 存储选型的量级感（运维必背）

| 方案 | 首 token 延迟 | 顺序吞吐 | 适合 |
|------|--------------|---------|------|
| S3 直读 | 秒级（冷） | 100MB/s~GB/s（看前缀） | 冷存/首次拉取 |
| 对象存储 + 本地缓存 | 首次慢后快 | NVMe 级 | **训练数据主路径** |
| JuiceFS/Lustre/GPFS 挂载 | 毫秒 | 多 GB/s 聚合 | 共享数据集、多节点并发读 |
| 本地 NVMe | 微秒 | 3-7 GB/s/盘 | shuffle 后的热数据 |

**多节点读同一数据集**是训练特有场景（Web 服务无此需求）——8 个节点同时打同一个存储，聚合带宽要 ×8 预算。这就是为什么正经训练平台必有**并行文件系统或对象存储+CDN 式缓存**，S3 直读只配做冷备。

## 分布式采样与打散（容易踩的坑）

```python
# 多节点训练：每卡只能看到自己 1/N 的数据（否则梯度浪费在重复样本上）
sampler = DistributedSampler(dataset, shuffle=True, seed=42)
# 坑1：seed 必须固定——不同节点 seed 不同 = 各卡数据集不同 = 采样灾难
# 坑2：shuffle 要在 sampler 层做（DataLoader shuffle=True 与 DistributedSampler 互斥）
```

**面试题**：「为什么 DataLoader 的 shuffle=True 配 DistributedSampler 会报错？」——因为打散的职责已上移到 sampler（保证各 rank 打散结果互补不重叠），DataLoader 再打散会破坏 rank 间切分。

## 数据格式：jsonl vs parquet vs 预 tokenize

- jsonl：人类可读、通用、慢（每条都要解析）
- parquet：列存压缩、吞吐 5-10×——**大训练集事实标准**
- 预 tokenize（.bin/.npy）：把 tokenize 提前做完，训练时零 CPU——追求 MFU 极限的预训练标配

---

**今日作业**：你的训练 GPU 利用率呈 30%↔95% 锯齿，写出完整诊断链（提示：从 DCGM 锯齿形态 → IO wait → num_workers → 存储方案的判断顺序）。
