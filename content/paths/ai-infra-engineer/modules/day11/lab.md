---
title: 实验六 · 看懂一个真实分布式训练的骨架
---

# 🧪 动手实验 · Day 11

> **目标**：不改训练代码，练「读」——从一段最小 DDP 脚本里指认出运维要盯的每个对象（rank/world_size/checkpoint 点/NCCL 初始化）。读代码能力是训练侧排障的前提。
>
> 三档：**真机**（两卡跑通最小 DDP）／**模拟**（CPU+gloo 后端单机多进程）／**纸上**（代码阅读题）。

---

## 档位 C · 纸上（核心档，人人过关）

下面是一段精简的真实 DDP 脚本。**先自己回答 4 个问题，再展开对照**：

```python
import torch, torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP

dist.init_process_group(backend="nccl")          # (A)
rank = dist.get_rank(); world = dist.get_world_size()
torch.cuda.set_device(rank % torch.cuda.device_count())

model = BigModel().cuda()
ddp_model = DDP(model)                            # (B)

sampler = torch.utils.data.distributed.DistributedSampler(dataset)
loader = DataLoader(dataset, sampler=sampler, batch_size=32)

for epoch in range(EPOCHS):
    for x, y in loader:
        loss = ddp_model(x, y).loss()
        loss.backward()                           # (C)
        optimizer.step(); optimizer.zero_grad()
    if rank == 0:                                 # (D)
        torch.save(model.state_dict(), f"ckpt_{epoch}.pt")   # (E)
```

**问题 1**：(A) 处进程组初始化时，每个进程怎么知道「自己是谁」？没配错会怎样？

<details><summary>对照</summary>

launcher（torchrun）给每个进程注入环境变量 `RANK`/`WORLD_SIZE`/`MASTER_ADDR`/`MASTER_PORT`，init 读这些变量完成握手。**world_size 与实际 GPU 数不一致是训练任务最经典的秒挂场景**——运行时环境（K8s 申请的卡数）与代码假设不符。运维侧的防线：任务模板里 GPU 申请数与 `--nproc_per_node` 用同一变量渲染。
</details>

**问题 2**：(C) 处 loss.backward() 里发生了什么「不可见的跨机通信」？

<details><summary>对照</summary>

梯度分桶 AllReduce：反向传播算完一桶梯度，NCCL 异步发起该桶的集合通信，与剩余层的反向计算重叠。**排障含义**：卡在 backward 里 = 大概率卡在集合通信（NCCL hang），而不是计算慢——`py-spy dump` 看栈在 `ncclAllReduce` 即可确诊。
</details>

**问题 3**：(D)(E) 为什么要 `if rank == 0`？去掉会发生什么？

<details><summary>对照</summary>

每个 epoch 有 world_size 个进程都执行到这——不加判断会存 N 份同样的 checkpoint，且 N 个进程**同时写同一文件路径会互相覆盖/损坏**（尤其共享挂载的 NFS/对象存储）。日志与 tensorboard 同理（N 份重复日志是训练任务最常见脏输出）。
</details>

**问题 4**：训练跑了一半，rank 3 的进程 OOM 死了。其他 7 个 rank 会怎样？该怎么发现？

<details><summary>对照</summary>

其他 rank 全部卡死在下一个 AllReduce 等待点（集合通信同步语义）。**发现手段**：① 任务超时熔断（torchrun 的 `--timeout` 或 K8s Job activeDeadline）；② 各 rank 日志心跳——rank 3 有 traceback 而 3~7 的日志停在同一个通信点，即「死者 + 等死者」的典型指纹；③ NCCL 调试环境变量 `NCCL_DEBUG=INFO` 能打印阻塞在哪个集合调用。
</details>

---

## 档位 B · 模拟（无 GPU，任何机器）

CPU + gloo 后端一样能走完整套分布式机制（只是慢、无 NCCL）：

```bash
# 单机 2 进程「分布式」训练（gloo 后端，CPU 可跑）
cat > mini_ddp.py <<'EOF'
import os, torch, torch.distributed as dist
import torch.nn as nn
from torch.nn.parallel import DistributedDataParallel as DDP

dist.init_process_group(backend="gloo")   # CPU 用 gloo 而非 nccl
rank = dist.get_rank(); world = dist.get_world_size()

torch.manual_seed(42)
model = nn.Sequential(nn.Linear(64, 64), nn.ReLU(), nn.Linear(64, 1))
ddp = DDP(model)

data = torch.randn(256, 64); target = torch.randn(256, 1)
for step in range(5):
    # 手动切分数据：每个 rank 只看自己那 1/world 份
    shard = data[rank::world], target[rank::world]
    loss = ((ddp(shard[0]) - shard[1]) ** 2).mean()
    loss.backward()
    if rank == 0:
        print(f"step {step} loss {loss.item():.4f}")
    for p in model.parameters():   # 手动 SGD（演示梯度已自动同步）
        p.data -= 0.01 * p.grad
        p.grad = None
dist.destroy_process_group()
EOF
torchrun --nproc_per_node=2 mini_ddp.py
```

**验证梯度真的被同步了**：把两个进程各自的 `p.grad` 打出来对比——**DDP 之后它们完全一致**（AllReduce 的效果），这就是「多卡吃不同数据但模型同步」的直接证据。再故意杀掉一个进程观察另一个 hang 住（Ctrl+C 退出）——亲手体验集合通信的同步性。

---

## 档位 A · 真机（两卡以上）

```bash
# 真正的 NCCL 后端（改 backend="nccl" + .cuda()）
# ① 验证 NCCL 通信健康（训练前的例行体检）
python -c "
import torch, torch.distributed as dist
dist.init_process_group('nccl')
t = torch.ones(1024, 1024, device='cuda')
dist.all_reduce(t)
print('allreduce ok, rank', dist.get_rank())
" && torchrun --nproc_per_node=2 mini_ddp.py

# ② 对照：NCCL_DEBUG=INFO 跑一轮，观察通信建立过程
NCCL_DEBUG=INFO torchrun --nproc_per_node=2 mini_ddp.py 2>&1 | grep -E "NCCL INFO (Init|Connected)" | head -5
```

真机加做一件事：`nvidia-smi` 观察 2 进程各占一张卡（进程↔卡一一对应），以及训练时**两张卡的 SM 利用率同涨同跌**（同步语义的直观体现——一卡等待时另一卡也空闲）。

---

## ✅ 实验完成清单

- [ ] 我指认出了脚本里的 5 个运维关键点（A-E）
- [ ] 我能解释「卡在 backward = 疑似 NCCL hang」的判断依据
- [ ] （模拟/真机）我亲眼见过一次「一卡死全体等」或梯度同步的证据
- [ ] 我理解 rank 0 检查点/日志去重是防「N 份重复 + 互相覆盖」
