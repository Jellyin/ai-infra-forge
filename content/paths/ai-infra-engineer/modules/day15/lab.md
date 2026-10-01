---
title: 实验十 · 做一次真实的断点续训
---

# 🧪 动手实验 · Day 15

> **目标**：故意杀死训练→从 checkpoint 恢复→验证 loss 连续性。练的是万卡集群每天发生 8 次的事（Meta 数据）。
>
> 三档：**实操**（本地小模型）／**纸上**（容错账 + 恢复流程排序题）。

---

## 档位实操（任何机器，CPU 可跑）

```bash
cat > ckpt_resume.py <<'EOF'
import torch, os, sys
from torch.utils.data import DataLoader, TensorDataset

torch.manual_seed(0)
X = torch.randn(400, 32); Y = torch.randn(400, 1)
model = torch.nn.Linear(32, 1)

def save_ckpt(path, step):
    torch.save({
        "model": model.state_dict(),
        "optim": opt.state_dict(),          # ★ 优化器状态——三要素之一
        "step": step,                        # ★ 数据位置——三要素之三
    }, path)

opt = torch.optim.Adam(model.parameters(), lr=1e-3)
loader = DataLoader(TensorDataset(X, Y), batch_size=16, shuffle=True)

CRASH_AT, RESUME = int(sys.argv[1]), len(sys.argv) > 2
start = 0
if RESUME and os.path.exists("ckpt.pt"):    # 恢复三要素
    c = torch.load("ckpt.pt")
    model.load_state_dict(c["model"]); opt.load_state_dict(c["optim"])
    start = c["step"]
    print(f"恢复自 step {start}")

for epoch in range(3):
    for i, (x, y) in enumerate(loader):
        step = epoch * 25 + i
        if step <= start: continue           # ★ 跳过已训数据（sampler 位置）
        loss = ((model(x) - y) ** 2).mean()
        loss.backward(); opt.step(); opt.zero_grad()
        if step % 5 == 0: print(f"step {step} loss {loss.item():.4f}")
        if step % 20 == 0: save_ckpt("ckpt.pt", step)
        if step == CRASH_AT:
            print(f"*** step {step} 模拟节点宕机 ***"); os._exit(1)
EOF

# 第一幕：正常训，20 步存一次，25 步时杀死（模拟故障）
python ckpt_resume.py 25
# 第二幕：从 checkpoint 恢复——观察 loss 是否连续！
python ckpt_resume.py 999 resume
```

**核心观察**（对照 guide 的五步恢复）：
1. 恢复打印「恢复自 step 20」（最近完整保存点）
2. **step 25 的 loss 与中断前量级连续**——因为优化器状态（Adam 动量）也恢复了
3. **对比实验**：把 `opt.load_state_dict(c["optim"])` 注释掉再恢复——loss 跳变！**这就是缺优化器状态的铁证**（自己动手做一次，印象极深）

## 纸上档

**容错账**（guide 作业的答案对账）：8×H100（$30/h），每 2000 步存一次、同步保存 90s；故障率 1 次/6h。

<details><summary>对照</summary>

- 同步方案：每次保存损耗 90s 训练时间；6h 内约存 27 次 ≈ 40min/6h ≈ **每日损失 2.7h × $30 × 8 卡 = $648/天**，且故障平均丢 1000 步
- 异步（9s 阻塞）：保存损耗 27×9s ≈ 4min/6h ≈ 每日 $15；故障靠 checkpoint 起点重跑
- **月差 ≈ $18,990**——这就是「分层异步保存」的 ROI，面试讲这个数字非常有说服力
</details>

**流程排序题**：打乱恢复五步后排序：(a)拉 ckpt 到本地 NVMe (b)排除故障节点 (c)load+恢复 sampler (d)找最新完整 ckpt (e)验证前 10 步 loss 连续 → **d b a c e**（先确认哪份能用，再清环境，再拉数据，再恢复，最后验证）。

---

## ✅ 实验完成清单

- [ ] 我完成了 杀死→恢复 全流程，看到 loss 连续
- [ ] 我亲手注释掉优化器恢复看到了 loss 跳变
- [ ] 我算得出同步 vs 异步保存的成本差
- [ ] 我能默写恢复五步的正确顺序
