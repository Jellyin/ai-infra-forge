---
title: 实验十九 · 把知识库上线，并分别演练三类回滚
---

# 🧪 动手实验 · 里程碑 19

> **本里程碑的交付物**：① 制品版本化表（填满真实标识） ② 含质量门禁的金丝雀配置 ③ 可自动校验的上线检查单 ④ **三类回滚的分别计时记录**。
> **验收标准**：你能当着同事的面说清「这次发布用了哪个模型、哪版提示词、哪个索引快照」，并在 5 分钟内分别演示一次应用回滚与一次索引回滚。
>
> 三档任选：**档位 A 真实项目**（有 GitOps 与真实向量库）／**档位 B 本地练习**（kind 起集群 + 本地向量库，做一次「发布 → 观测 → 回滚」）／**档位 C 纸上评审**（40 分钟，给一条故障时间线，判断止血顺序与影响面）。

---

## 档位 A · 真实项目（把前 18 个里程碑接上流水线）

### 1. 填制品版本化表并产出 release manifest

```bash
git rev-parse HEAD                        # 代码版本
git -C ./prompts rev-parse HEAD           # 提示词版本（提示词是制品）
# 模型：引用 index digest（不是单架构 digest）
docker buildx imagetools inspect "$REG/kb-infer:1.0.0" --format '{{json .Manifest.Digest}}'
```

索引快照与 embedding 版本——字段名**随向量库版本演进，以官方文档为准**：

```bash
# Qdrant 示意
curl -s "$QDRANT/collections" | jq '.result.collections[].name'
curl -s -X POST "$QDRANT/collections/kb/snapshots" | jq '.result.name'
curl -s "$QDRANT/collections/kb" | jq '.result.config.params.vectors'
```

把五元组写进 `release.json` 并注入环境变量，让输出带 `release_id`。再把 m03–m06 的索引构建写成**流水线 job**，产出**不可变快照 + digest**，按 dev→staging→prod 晋级（只改引用，不重建）。判据：**两环境的 embedding 与向量库版本一致**。

### 2. 金丝雀 + 质量门禁

抄 guide 19.5 的 `AnalysisTemplate` 接到 `Rollout`：`setWeight: 10` → `analysis` → `pause: {}`。发布后看三个信号：错误率、引用覆盖率、p95。**引用覆盖率掉了，即便错误率正常也不该放量。**

### 3. 三类回滚分别计时（本实验核心产物）

| 回滚对象 | 命令 / 动作 | 起点 | 完成 | 耗时 | 一次成功？ |
|---|---|---|---|---|---|
| 提示词 | `git revert` + 重载 | | | | |
| 应用/编排 | `kubectl rollout undo` / `argocd app rollback` | | | | |
| 模型 | 切回旧权重（或旧服务） | | | | |
| 索引（切别名·快路径） | `alias` 指回旧快照 | | | | |
| 索引（重建·兜底） | 重新构建并回填 | | | | |

**必须写出结论**：切别名与重建各要多久？若这次换了 embedding，**模型与索引是不是必须一起回**？

---

## 档位 B · 本地（kind：做一次「发布 → 观测 → 回滚」）

目标：用最小可用的两层，把「两类制品分别回滚」练成肌肉记忆。

```bash
kind create cluster --name kb-rehearse
kubectl create deployment kb-api --image=nginx:1.25 --replicas=2
kubectl rollout status deployment/kb-api
```

**制造一次坏发布并观测**（本地无 Prometheus，以 pod 状态与事件为信号）：

```bash
kubectl set image deployment/kb-api nginx=nginx:does-not-exist   # 卡在 ImagePullBackOff
kubectl get pods -l app=kb-api -w        # Ctrl-C 退出
kubectl describe pod -l app=kb-api | tail -20
```

**应用回滚并计时**：

```bash
time kubectl rollout undo deployment/kb-api
kubectl rollout status deployment/kb-api
kubectl rollout history deployment/kb-api     # 每次 undo 也是新 revision，可追溯
```

**用 ConfigMap 模拟索引别名切换**（本档位关键动作——演练「索引回滚 ≠ 应用回滚」）：

```bash
# 两个“快照”；发布新索引 = 别名切到 snapshot-b
kubectl create configmap kb-index-alias \
  --from-literal=alias=snapshot-a --dry-run=client -o yaml | kubectl apply -f -
kubectl patch configmap kb-index-alias --type merge -p '{"data":{"alias":"snapshot-b"}}'  # 索引“发布”
time kubectl patch configmap kb-index-alias --type merge -p '{"data":{"alias":"snapshot-a"}}'  # 索引“回滚”
```

| 你的观察 | 结论 |
|---|---|
| 应用回滚与索引回滚是**两条独立路径** | 只回一个会留下「旧编排配新索引」的错配 |
| 索引回滚只改一个指针，秒级完成 | **快路径是切别名，不是重建** |
| 别名的旧值必须**仍然存在**才能切回 | 快照未删除是回滚的前置条件 |

> 注：kind 默认**不含 metrics-server**，`kubectl top` 不可用；本档位以 pod 状态与事件为观测信号，容量观测留到 m20。

---

## 档位 C · 纸上评审（40 分钟）

读下面这条**按时间顺序记录的故障时间线**，回答两问：**止血顺序**（先动哪一类制品）与**影响面**（谁受影响、多久）。

```text
09:00  发布 v2：换新 embedding 模型 + 新提示词 + 重建索引（三件一起发）
09:05  错误率正常（HTTP 200），金丝雀放量到 100%
09:30  客服反馈「答非所问」变多，但没有报错
09:40  命中率 82%→31%，引用覆盖率 91%→44%
09:42  决定回滚：运维先回滚了应用镜像（v2 → v1）
09:45  命中率仍 33% —— 没恢复
10:20  开始重建索引以“回滚索引”，预计 90 分钟
11:50  重建完成，命中率回到 80%
```

<details><summary>对照答案（先写完再看）</summary>

**止血顺序错了，错在两点：**

1. **先回滚了应用，却漏了「模型与索引必须一起回」**。本次变更含 embedding 变更——按 19.6，模型与索引**必须一起回**。只回应用镜像，索引仍是新 embedding 建的，新旧向量空间不匹配，**静默失效继续**（09:45 仍 33% 即证据）。
2. **用了重建而非切别名**。索引回滚的秒级路径是「别名指回旧快照」。旧快照发布前就该保留，本可 **09:45 之前**一次原子切换恢复；因走重建，多停了 **2 小时 5 分**。

**正确顺序**：① 判定是否含 embedding 变更 → 是，则**同时**冻结新流量、切别名回旧快照、切回旧模型/提示词（一条原子回滚）；② 再看应用镜像是否需要回——不是第一动作。

**影响面**：09:05–11:50（约 **2 小时 45 分**）所有提问者受影响；因**无报错**，极可能未被自动告警发现，靠投诉才暴露——这正是「引用覆盖率」必须进门禁的原因（09:40 复原出的曲线，本应在 09:15 金丝雀阶段被拦下）。**根因**：把「三类回滚」当成一个动作，且没演练过索引回滚的真实耗时。

</details>

### 最后一问

这次最贵的代价是**「静默失效 + 回滚路径选错」叠加**。若只能加一条防线，你加在**发布前**（强制四元组绑定与评测门禁）、**发布中**（质量门禁拦放量）、还是**发布后**（分钟级切换/重建演练）？写下理由。

---

## 交付物验收清单

| 交付物 | 通过标准 | 你的产出 |
|---|---|---|
| 制品版本化表 | 模型/提示词/索引/评测集齐全，各含版本标识与存放位置 | |
| release manifest | 五元组非空，能注入服务并被观测回溯 | |
| 金丝雀门窗禁 | 含错误率 + 一项 RAG 质量指标（如引用覆盖率） | |
| 上线检查单 | 自动项做成会 fail 的 job；人工项 ≤ 3 条 | |
| 三类回滚计时记录 | 提示词/应用/模型/索引分别计时；注明切别名 vs 重建 | |
| 多架构核对 | 镜像 index digest 双架构齐全，部署清单架构对齐 | |

> **收束句**：能上线的系统，是**能解释自己用了哪些制品**、并**能分别把它们退回去**的系统。做不到这两点，你的「发布」只是「覆盖」。
