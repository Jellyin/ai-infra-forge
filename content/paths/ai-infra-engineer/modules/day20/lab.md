---
title: 实验十五 · Phase 2 毕业流水线
---

# 🧪 动手实验 · Day 20（阶段毕业设计）

> **目标**：把 day11-19 焊成一条**一条命令能跑通**的 mini 流水线：数据→微调→评测→合并→上线→对照。这是 Phase 2 的通关凭证。
>
> 之前各天 lab 的组件都已就绪——今天的活是**串线**。

---

## 串线（把已做过的组件接起来）

```bash
# 一条命令的骨架（Makefile 或 run_all.sh）
cat > run_all.sh <<'EOF'
set -e                                    # 任一环失败即停（红线意识）
echo "=== Step1 数据（Day14）==="
python build_dataset.py --out data/ --eval-ratio 0.1
echo "=== Step2 微调（Day13/17）==="
python lora_sft.py --data data/train.jsonl --out ./out
echo "=== Step3 评测红线（Day17）==="
python eval.py --adapter ./out --data data/eval.jsonl | tee eval_report.txt
# 红线：eval loss > train loss × 1.2 则 exit 1（自动拦截，不给发布）
python check_eval_gate.py eval_report.txt
echo "=== Step4 合并导出（Day17）==="
python merge_export.py --base Qwen/Qwen2.5-0.5B-Instruct --adapter ./out --out ./merged
echo "=== Step5 上线（Day7 回炉）==="
vllm serve ./merged --port 8000 &
echo "=== Step6 20题对照（验收）==="
python compare_20q.py --base-port 8001 --finetuned-port 8000 | tee compare.txt
EOF
chmod +x run_all.sh && ./run_all.sh
```

**要点不是脚本本身**，是三件事：
1. **`set -e` + 评测 gate**——红线自动化（比「人工记得看 eval」可靠一个数量级）
2. 每步 `tee` 留痕——流水线的可审计性（对应 Day 19 的账单思想）
3. 对照表落盘——验收证据（面试的「20 题对照」拿出来就是实践）

## 纸上档（无环境替代）

交一份「影子流水线」表格（5 行）：

| 环节 | 输入 | 输出 | 把关指标 | 翻车模式 |
|------|------|------|---------|---------|
| 数据 | 原始语料 | train/eval.jsonl | 去重率、长度分布 | 脏数据→loss spike |
| 微调 | train.jsonl | adapter | train loss 收敛 | lr/格式错→loss 不动 |
| 评测 | eval.jsonl + adapter | eval loss | **eval≈train（±20%）** | 过拟合→回炉 |
| 合并 | base+adapter | merged 模型 | 文件完整性 | 没套 template→答非所问 |
| 上线 | merged | vLLM 服务 | TTFT 与底座一致 | 合并漏做→延迟增加 |

---

## Phase 2 毕业自查（对照 day11-19 各 checklist + 本日硬性项）

- [ ] run_all.sh 一条命令跑通（或交影子流水线表）
- [ ] 评测红线自动化（不是人工看）
- [ ] 20 题对照表落盘
- [ ] 我能白板画全链路并标注每天学的知识在哪一环

**通关后**：你已具备「训练侧基础设施」完整认知链——DP/DDP/FSDP 演进、NCCL 排障、数据管道、checkpoint 容错、训练调度、微调工程化、MFU 可观测、多租户经营。**这正是 Tier B（GPU 集群运维）岗 JD 的一票否决项清单。** Phase 3（生产化纵深+终极面试关）待建设中——现在先回 Day 10 复盘面试，或开始用 Phase 1 的推理侧知识投简历（两条线技能已互补成完整画像）。
