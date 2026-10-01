---
title: 实验九 · 亲手饿一次 GPU 并确诊
---

# 🧪 动手实验 · Day 14

> **目标**：制造一次「数据饿 GPU」，看到锯齿形态，走完整个诊断链——这个模式识别能力直接对应生产排障。
>
> 三档：**实操**（本地 CPU 模拟锯齿，无需 GPU）／**纸上**（诊断题）。

---

## 档位实操（任何机器）

用一个故意的慢加载器制造「计算快、数据慢」：

```python
cat > io_bound_demo.py <<'EOF'
import torch, time
from torch.utils.data import Dataset, DataLoader

class SlowDataset(Dataset):
    def __len__(self): return 200
    def __getitem__(self, i):
        time.sleep(0.02)          # 模拟慢 IO/解码（20ms/条）
        return torch.randn(64)

model = torch.nn.Sequential(torch.nn.Linear(64, 64), torch.nn.Linear(64, 1))

def bench(num_workers, prefetch):
    loader = DataLoader(SlowDataset(), batch_size=8,
                        num_workers=num_workers, prefetch_factor=prefetch)
    t0 = time.time()
    for batch in loader:
        model(batch).sum().backward()   # 「GPU 计算」（极快，把 IO 差距放大）
    return time.time() - t0

for w in [0, 2, 4, 8]:
    print(f"num_workers={w}: 总耗时 {bench(w, 2 if w else None):.1f}s")
EOF
python io_bound_demo.py
```

**观察三行数**（记录它们）：
- `num_workers=0`（数据串行）：最慢——**这就是 GPU 锯齿的微观形态**（算 1ms 等 160ms）
- workers=4：约 4× 提速（IO 并行化）
- workers=8：提速饱和甚至下降（进程开销 > 收益）——**workers 不是越大越好**，CPU 核数是上界

**结论链**：GPU 锯齿 → 加大 num_workers → 吞吐抬升 = 确诊 IO 瓶颈。若加 workers 也没用 → 存储层到顶 → 上缓存/换存储方案。

## 纸上档（诊断题）

**场景**：32 节点训练，单节点测 MFU 45%，全集群 MFU 只有 22%。节点内 DCGM 显示 SM 利用率锯齿。列出诊断顺序。

<details><summary>对照</summary>

① 锯齿+全集群劣化+单节点正常 → **跨节点共用的资源**是瓶颈：共享存储（32 节点并发读打爆聚合带宽——验证 iostat/存储侧 QPS）；② 查 DataLoader 各节点是否都直读远端（应加本地缓存层）；③ 查 NCCL transport（通信退化会同步放大等待）；④ 最后查数据预处理 CPU（各节点 workers 不足）。
</details>

---

## ✅ 实验完成清单

- [ ] 我看到并记录了 workers 0→4→8 的耗时曲线
- [ ] 我能背「锯齿→加 workers→没用→查存储」的判断链
- [ ] 我理解多节点并发读共享存储的聚合带宽预算（×N）
