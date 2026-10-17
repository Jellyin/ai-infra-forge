---
title: 实验十一 · 把环境矩阵写成规则
---

# 🧪 动手实验 · Day 11

> **目标**：把一个「靠口头约定」的环境矩阵，落成可执行的规则——环境声明、受保护入口、审批、回滚窗口清单。老 DevOps 一定见过「没人说得清 prod 到底怎么上」的团队，本实验就是把它钉死。
>
> 三档任选：**档位 A 真环境**（有 GitLab 项目 + 可部署目标）／**档位 B 本地**（只有 `kind` 或 `minikube`，无云可做）／**档位 C 纸上**（15 分钟，纯推理）。

---

## 档位 A · 真环境（有 GitLab 项目）

### 1. 把环境写进 CI 配置

```yaml
# .gitlab-ci.yml 片段
stages: [build, deploy]

deploy:review:
  stage: deploy
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    url: https://$CI_COMMIT_REF_SLUG.review.example.com
    on_stop: stop:review
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script: [./deploy.sh review]

stop:review:
  stage: deploy
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    action: stop
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: manual
  script: [./teardown.sh review]
```

观察：合并/关闭 MR 后，`review` 环境是否会随 `on_stop` 被清理。**没有被清理的临时环境，就是矩阵里的僵尸。**

### 2. 给 prod 装配受保护环境

到项目 **Settings → CI/CD → Protected environments**：把 `prod` 加进去，指定「允许部署的角色/用户」与「允许批准的成员」。再回到 **Operate → Environments** 查看部署历史。

| 观察项 | 你的记录 |
|---|---|
| 谁能部署 prod | |
| 谁能批准 prod | |
| 无权限者触发部署时的表现 | |

### 3. 验证手动门禁的「假绿灯」

把 `deploy:prod` 设为 `when: manual`，触发一次主干流水线**但不点它**。

**关键观察**：流水线显示「通过」，但 prod 仍是旧版本。这就是 Day 1 的假绿灯在 CD 阶段重演——**绿灯 ≠ 已部署**。

---

## 档位 B · 本地（`kind` / `minikube`，无云）

用命名空间模拟环境隔离，亲手验证「隔离是否真的成立」。

```bash
# 起一个本地集群
kind create cluster --name envlab

# 为每个环境建独立命名空间（最小隔离单元）
for e in dev review staging prod; do kubectl create namespace app-$e; done
kubectl get namespaces --show-labels
```

### 1. 验证凭证隔离（同一名字，不同真值）

```bash
# 每个环境放一份同名 Secret，但值不同
kubectl -n app-dev  create secret generic db --from-literal=url=dev-db
kubectl -n app-prod create secret generic db --from-literal=url=prod-db
```

**结论**：隔离靠的不是 Secret 名字，而是 **namespace + RBAC**。名字相同不代表值相同——这正是「最小隔离集」里说的：命名空间是下限，凭证隔离才是防线。

### 2. 验证网络隔离

```bash
# 默认拒绝所有入站（先全拒，再按需放行）
cat <<'YAML' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: app-prod
spec:
  podSelector: {}
  policyTypes: [Ingress]
YAML
```

从 `app-dev` 起一个 Pod 去连 `app-prod` 的服务，记录结果。

| 观察项 | 你的记录 | 结论 |
|---|---|---|
| 未加 NetworkPolicy 时能否互通 | | 默认全通 = 没有网络隔离 |
| 加了 default-deny 后 | | 显式放行才有流量 |

---

## 档位 C · 纸上（15 分钟，无需环境）

**场景**：团队只有一条流水线，`main` 上每次 push 都**直接部署到 prod**。没有 staging，没有审批；数据库迁移脚本和代码在同一个 job 里跑。三个人都有 prod 部署权限，凭证放在 CI 变量里。上周一次发布把用户表的一列删了，出事后**无法回滚**。

请回答：① 环境矩阵该怎么调整？② 入口该怎么收？③ 这次「删列」的变更，本就该被怎么拆？

<details><summary>对照答案（先写完再看）</summary>

**① 环境矩阵**：至少补一条 **staging**（与 prod 同构、用脱敏数据）作为晋升前的最后一道；把每个分支对应的验证改成 **review 临时环境**（随 MR 生灭），让主干保持可发布状态。晋升路径显式化：dev → review → staging → prod。

**② 入口**：prod 用**受保护环境**限制部署者与批准者（不是所有人都能上）；`main` 用**受保护分支**限制谁能合入；手动门禁要有追责记录，而不是任何人都能点的 `when: manual`；CI 里不该长期存放 prod 凭证（Day 12 会用 GitOps 彻底移走凭证）。

**③ 「删列」的拆法**：按 expand / contract 拆分——先加新列并双写 → 回填 → 切读 → 观察一段时间 → 才删旧列。任何一步都能单独回滚，把「不可回滚的窗口」拆散。迁移脚本还必须**先在 staging 验证**，且与代码发布解耦（Day 13 的 hook 会处理这个顺序）。

</details>

### 最后一问（写下你的答案）

你的项目里，**哪些变更是不可回滚的**？列出来，并为每条写下「回滚窗口有多长、窗口内怎么退、窗口外怎么办」：

| 变更 | 回滚窗口 | 窗口内退路 | 窗口外怎么办 |
|---|---|---|---|
| | | | |
| | | | |

<details><summary>提示</summary>

典型答：数据库破坏性 schema 变更（窗口到迁移执行完为止，退路是备份 + 前滚修复）、对外 API 契约变更（窗口到有外部消费者为止，退路是版本共存）、已发事件（窗口为零，只能补发纠正事件）。共同点：**窗口一旦关闭，就只能往前修，不能往后退**——所以要在窗口内把退路准备好。
</details>
