---
title: PyTorch 分布式训练演进
---

# Day 11 · PyTorch 分布式训练演进

> 目标：把「跑模型」从单卡思维升级为多卡协作思维——DP/DDP/FSDP 的演进逻辑

## 为什么训练和推理的「多卡」完全不是一回事

推理侧你已经很熟：TP/PP 是把**一个模型的推理**拆到多卡。训练侧的多卡是另一件事——**同一个模型的多份副本各自吃不同数据，梯度要保持同步**。这决定了训练基础设施的核心难题：

- 梯度怎么同步（通信原语）
- 显存怎么省（参数/优化器状态的分片）
- 进程怎么管理（launcher/进程组）

## 演进三步：DP → DDP → FSDP

### DP（DataParallel）——被淘汰的第一代

```
主线程 scatter 输入 → 复制模型到 N 卡 → 各卡前向/反向 → 主卡汇聚梯度 → 更新
```

两个致命伤：① 单进程多线程，撞 Python GIL；② **梯度全部汇聚到主卡再广播**——主卡通信与显存都是 N 倍热点。这就是为什么现代栈里 DP 只出现在历史代码。

### DDP（DistributedDataParallel）——当前默认

每卡一个**独立进程**，各持完整模型副本，吃不同数据：
- backward 时**梯度分桶**（bucket），算完一桶就异步发起 AllReduce——通信与计算重叠
- 通信原语：**Ring-AllReduce**（下一章 NCCL 详讲），每卡收发数据量 ≈ 2×模型大小/N，无主卡热点
- 显存：每卡都存**全量参数 + 全量优化器状态**——70B 模型 Adam 状态就要 70×12≈840GB/卡

### FSDP（Fully Sharded Data Parallel）——大模型标配

把 DDP 的「每卡全量」改成「每卡分片」：
- 参数/梯度/优化器状态**全部切片**分布在各卡，用到哪层才临时聚合（all-gather）该层
- 显存从 O(全模型) 降到 O(全模型/N)——70B 训练从「不可行」变「4×8 卡可行」
- 代价：每层前后都多两次通信（gather/scatter），用计算换显存

**面试一句话**：DDP 解决的是「多卡怎么高效同步梯度」，FSDP 解决的是「模型大到单卡放不下怎么办」。它们不互斥——先有通信效率问题，再有显存分片需求。

## 进程与 launcher 的运维视角

```bash
# torchrun 起 8 个进程，NCCL 后端，每进程拿到自己的 rank
torchrun --nproc_per_node=8 train.py
# train.py 内部:
#   torch.distributed.init_process_group(backend="nccl")
#   rank = torch.distributed.get_rank()       # 我是第几个进程
#   world_size = torch.distributed.get_world_size()  # 一共几个
```

运维要盯的三件事：① **world_size 与申请的 GPU 数必须一致**（不一致直接挂）；② rank 0 是「主进程」（存 checkpoint/打日志/写 tensorboard 都只在 rank 0，避免 N 份重复输出）；③ 一个进程 hang 住全体卡死——这就是训练任务比 Web 服务排障难的本质（下一章 NCCL 详讲）。

---

**今日作业**：用 300 字向自己解释「为什么训练任务一卡 hang 全体卡死，而推理服务单卡挂了只是容量下降」——这是训练/推理运维心智差异的核心。
