---
title: 实验七 · 制造并诊断一次 NCCL 事故
---

# 🧪 动手实验 · Day 12

> **目标**：NCCL 排障能力只能「制造事故→看指纹」来练。本实验故意制造 hang、故意看走 TCP 的退化、读真实形态的 hang 日志——练的是诊断模式识别。
>
> 三档：**真机**（多卡制造真 hang）／**模拟**（gloo 后端制造同样语义的 hang）／**纸上**（事故日志诊断题）。

---

## 档位 B · 模拟（无 GPU，人人可做）

gloo 后端没有 NCCL，但**集合通信的 hang 语义完全相同**——制造一次「凶手已死、死者排队」：

```bash
cat > hang_demo.py <<'EOF'
import torch.distributed as dist, os, time

dist.init_process_group(backend="gloo")
rank = dist.get_rank()

if rank == 1:
    print(f"[rank1] 我先退出——制造事故", flush=True)
    os._exit(1)          # rank 1 直接死

if rank == 0:
    print("[rank0] 发起 all_reduce，等待全员……", flush=True)
    t = torch.ones(10)
    dist.all_reduce(t)   # rank1 已死 → rank0 永远等待
    print("[rank0] 永远到不了这里", flush=True)
EOF
timeout 10 torchrun --nproc_per_node=2 hang_demo.py; echo "exit=$?"
```

**观察指纹**（这就是生产事故的缩小版）：
- rank 1 打印退出后 **rank 0 停在「等待全员」**——凶手有输出痕迹，死者安静排队
- `timeout 10` 杀掉（生产中这道防线 = K8s `activeDeadlineSeconds`）
- **去掉 timeout 重跑，任务永远挂着**——体验「没有超时配置 = 永远 Running」的第三类根因

再加超时配置对比：

```bash
# dist.init_process_group(backend="gloo", timeout=timedelta(seconds=5))
# → 5 秒后抛 RuntimeError 而不是永久 hang。生产必配！
```

---

## 档位 A · 真机（有 GPU）

```bash
# 1. 训练前通信体检（养成习惯）
nvidia-smi nvlink -s          # 机内 NVLink 状态
NCCL_DEBUG=INFO python -c "
import torch, torch.distributed as dist
dist.init_process_group('nccl')
import torch
t = torch.ones(1024,1024,device='cuda')
dist.all_reduce(t)
print('rank', dist.get_rank(), 'allreduce ok')
" && torchrun --nproc_per_node=<卡数> -m torch.distributed.run --standalone ...

# 2. 观察 NCCL 选择的 transport（健康 vs 隐形劣化）
NCCL_DEBUG=INFO torchrun --nproc_per_node=2 mini_ddp.py 2>&1 | grep -iE "transport|Channel" | head -10
# 期望看到 P2P/NVLS；看到 Socket = 走了 TCP 兜底（性能塌方信号）

# 3. 复刻模拟档的 hang 实验（nccl 后端 + rank1 秒退）
#    然后用 py-spy 看等死者的栈：
py-spy dump --pid <rank0进程pid>
# 栈停在 nccl 相关等待调用 → 「集合通信等待」确诊
```

---

## 档位 C · 纸上（事故日志诊断）

**事故 1**：8 卡训练，日志如下。谁是凶手？死因可能是什么？

```
[rank0] step 1200 loss 2.31
[rank2] step 1200 loss 2.30
[rank5] CUDA out of memory. Tried to allocate 2.00 GiB ...
(rank 1/3/4/6/7 无新日志，任务持续 Running 40 分钟)
```

<details><summary>对照</summary>

**rank 5 是凶手**（唯一有 traceback 的，OOM），其余 6 个是等死者（卡在 step 1200 之后的下一个 AllReduce）。处置：看 rank 5 的 OOM 是否可复现（batch/序列长度变化？）；等死者不用查——它们没病，只是没等到人。加 `--timeout` 与重试策略后重启任务。
</details>

**事故 2**：训练一直能跑，但速度从昨天的 1500 tok/s 掉到 130 tok/s。无任何报错。列出你的排查顺序。

<details><summary>对照</summary>

① `NCCL_DEBUG=INFO` 看 transport 是否从 IB/P2P 退化为 Socket（网络配置被动过/交换机端口坏）；② `ibstat` 查 IB 端口速率协商（是否从 200G 掉到 10G）；③ `nvidia-smi nvlink -s` 机内 NVLink；④ 对比 DCGM 的 SM 利用率与 XID 记录。**「无报错但慢 10 倍」的第一嫌疑永远是通信层退化**——训练慢的 80% 不是 GPU 病了，是网络病了。
</details>

**事故 3**：跨机 4 节点训练，节点 3 上任务状态永远 Running，其他节点日志停在同一 step。K8s 里这个 Job 没配任何超时。你现在的三个动作？

<details><summary>对照</summary>

① `kubectl exec`/`py-spy dump` 到各节点训练进程，找有 traceback 的（若都没有 → 网络层嫌疑，查节点 3 的 IB 链路）；② 立即补 `activeDeadlineSeconds` 与 torchrun `--timeout`（止血：不再无限占用 GPU）；③ 复盘：事故的根因未必是 bug，**「没有超时配置」本身就是缺陷**——GPU 每小时都在烧钱。
</details>

---

## ✅ 实验完成清单

- [ ] 我亲手制造（或纸上诊断）了一次「凶手已死、死者排队」的 hang
- [ ] 我能背出 Ring-AllReduce 的 2×N⁻¹ 模型并解释无主卡瓶颈的原因
- [ ] 我知道「能跑但慢 10 倍」第一嫌疑是 transport 退化为 Socket
- [ ] 我理解超时配置不是优化项而是必需品（GPU 时薪 × hang 时长 = 事故成本）
