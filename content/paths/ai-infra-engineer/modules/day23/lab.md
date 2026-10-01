---
title: 实验十八 · 亲手做一次摘卡演练
---

# 🧪 动手实验 · Day 23

> **目标**：完整走一遍「注入→观测→恢复→复盘」的演练循环。本地版无风险，练的是流程设计与度量习惯。
>
> 三档：**实操**（本地进程级演练）／**纸上**（runbook 写作 + 演练方案设计）。

---

## 档位实操（本地，零风险）

用 Day 15 的 checkpoint 实验做底，把它升级成一次**有度量的演练**：

```bash
# 演练脚本化：随机时刻杀死训练，度量恢复
cat > drill.sh <<'EOF'
#!/bin/bash
# 演练目标：验证训练遇节点崩溃的 MTTR
T0=$(date +%s)

python ckpt_resume.py 999 &          # 正常训练（Day15 的脚本）
TRAIN_PID=$!
sleep $((RANDOM % 15 + 5))           # 随机 5-20s 后注入

echo "[$(date +%H:%M:%S)] ★ 注入：kill 训练进程（模拟节点崩溃）"
kill -9 $TRAIN_PID                    # 故障注入

T1=$(date +%s); echo "故障发生"
python ckpt_resume.py 999 resume > /dev/null 2>&1   # 按预案恢复
T2=$(date +%s)

echo "★ 演练度量"
echo "  发现时长: 注入即知（真实场景要靠告警——见纸上题）"
echo "  恢复时长: $((T2-T1))s（从故障到续训完成）"
echo "  总 MTTR 模拟: $((T2-T0))s"
grep "恢复自" /dev/null || python ckpt_resume.py 0 resume 2>&1 | grep 恢复
EOF
chmod +x drill.sh && ./drill.sh
```

**记录三行数**：注入时刻、恢复耗时、恢复起点 step。跑 3 遍看恢复时长的方差——**方差大 = 预案不够自动化**（有人在犹豫）。

## 档位纸上

**题 1**：给「训练节点 XID 79」写四行 runbook。

<details><summary>对照参考</summary>

- 症状：任务日志 NCCL hang / DCGM 出 XID79 告警，节点 nvidia-smi 无响应
- 判断：① dmesg | grep -i nvidia 看驱动报错；② 该节点跑 `nvidia-smi` 确认掉卡；③ 对比相邻任务是否正常（隔离是单节点还是网络）
- 处置：① cordon 节点 + evict 该节点任务；② 任务侧按 checkpoint 续训（Volcano maxRetry 或平台自动重启）；③ 工单下线送修
- 升级：30 分钟未恢复叫平台负责人；同型号 3 台以上出 XID79 → 驱动/固件版本嫌疑，升级硬件团队
</details>

**题 2**：设计「存储网交换机单点故障」演练（不许真拔线版）。

<details><summary>对照参考</summary>

目标：验证 checkpoint 恢复链路对存储交换机的依赖与降级路径。
注入（软）：iptables 在存储挂载节点 DROP 存储网段流量 60 秒。
度量：任务表现（checkpoint 保存失败如何表现？会丢训练吗？）、恢复后重试是否自动。
验收：保存失败有明确告警（不是静默）、重试自动成功、训练零丢失（还在跑没被保存阻塞卡死）。
**演练发现的常见惊喜**：很多平台的 checkpoint 失败是静默的——任务跑了三天才发现最后成功保存在 60 小时前。这就是演练的价值。
</details>

**题 3**：演练和真实故障的 MTTR 关系怎么用数据证明价值？

<details><summary>对照</summary>

对比曲线：每次演练的 MTTR + 每次真实故障的 MTTR 放一张图。健康平台两条线应重合（≈演练水平）；真实故障远差于演练 = 有「演练没覆盖的未知路径」——那条路径就是下一次演练的目标。用「月均故障次数 × MTTR 差值 × GPU 时薪」把差值换算成钱，就是演练项目自己的 ROI。
</details>

---

## ✅ 实验完成清单

- [ ] 我跑通了本地演练循环并记录了恢复时长（含 3 次方差）
- [ ] 我写过至少一份四行 runbook
- [ ] 我能设计一个软注入的演练场景（含度量与验收）
- [ ] 我会用「演练 MTTR ≈ 真实 MTTR」的论断讲演练价值
