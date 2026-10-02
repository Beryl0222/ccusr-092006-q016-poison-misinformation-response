# 中毒误导信息响应

面向区域疾控中心的误导信息与暴露响应后端。雨后中毒来电高峰时，系统把公众提交、专家判断、指引版本与行动级别评估串成一条可审计的链路。

## 设计原则

- **不诊断、不确认物种**：系统只依据可观察症状、群体暴露与当时有效指引给出行动级别（联系急救 / 立即就医 / 持续留观）；蘑菇样本只保存线索描述，物种鉴定留给专家线下完成。
- **要素分开保存**：说法、来源链接、样本线索、食用时间、同餐关系、症状时间线各自独立存放，不混成一个备注串。
- **重复来电合并**：同一来电人，或进食时间接近（±3 小时）且地点 / 同餐人重合的提交，自动并入同一暴露事件。
- **缓解 ≠ 结案**：结案须满足——最后一次症状记录（含“已缓解”）已满指引观察窗、最新评估为持续留观、无待办重评；拦截会留痕（`CASE_CLOSE_REJECTED`）。
- **指引版本化**：每次评估记录所用指引版本；新版指引发布后，未结个案自动进入重评队列，已结案的不打扰。
- **全程可溯源**：评估、升级、判断、更正全部写入事件日志，值班人员可追到究竟哪条公开信息促成了风险升级。

## 快速开始

```bash
npm test          # 运行全部测试
npm start         # 启动服务（默认 :8080，PORT 环境变量可改）
```

提交一条来电：

```bash
curl -X POST http://localhost:8080/reports -H 'content-type: application/json' -d '{
  "channel": "hotline",
  "reporter": { "contact": "135****6666" },
  "meal": { "meal_at": "2026-10-01T18:00:00+08:00", "location": "某餐馆" },
  "claims": [{ "text": "AI识别说可食", "category": "IDENTIFICATION_PROMISE",
               "source_links": [{ "url": "https://app.example/ai1", "platform": "识别小程序" }] }],
  "sample_clues": [{ "description": "白色菌盖，有菌环", "kept": true }],
  "co_diners": [{ "person_ref": "aunt-1", "relation": "同餐" }],
  "symptoms": [{ "symptom": "VOMITING", "observed_at": "2026-10-01T21:00:00+08:00" }]
}'
```

## 行动级别规则（默认指引 2026.1）

| 规则 | 条件 | 行动级别 |
| --- | --- | --- |
| `RED_FLAG_SYMPTOM` | 任一红旗症状（意识模糊/抽搐/呼吸困难/黄疸/少尿/血便/晕厥）处于活动期 | 联系急救 |
| `DELAYED_ONSET` | 餐后 ≥6 小时才出现的胃肠症状 | 立即就医 |
| `GROUP_EXPOSURE` | 同餐出现症状人数 ≥2（缓解者仍计入） | 立即就医 |
| `DEFAULT_OBSERVATION` | 以上均未命中 | 持续留观 |

规则参数（观察窗 24h、延迟阈值 6h、群体阈值 2、红旗清单）全部来自指引版本，可随 `POST /guidelines` 更新。

## API 一览

| 方法与路径 | 说明 |
| --- | --- |
| `POST /reports` | 公众提交；自动合并重复来电并按当时有效指引评估。`external_ref` 提供传输层幂等 |
| `GET /reports/:id` | 提交详情 |
| `GET /incidents?status=` | 事件列表 |
| `GET /incidents/:id` | 事件视图（提交、最新评估、涉及说法、待办重评） |
| `POST /incidents/:id/assess` | 人工触发重估 |
| `POST /incidents/:id/close` | 结案；未达条件返回 409 `CLOSE_GUARD_REJECTED` |
| `GET /incidents/:id/trace` | 溯源：评估史、升级记录及促成升级的公开信息 |
| `GET /claims?status=` / `GET /claims/:id` | 说法登记库（含判断史与更正记录） |
| `POST /claims/:id/verdicts` | 专家判断：结论 + 证据 + 适用范围，版本自动递增 |
| `GET /guidelines` / `POST /guidelines` | 指引版本查询与发布；发布后未结个案自动入重评队列 |
| `GET /reevaluation-tasks?status=` / `POST /reevaluation-tasks/:id/complete` | 重评队列查询与办结（按新指引重估） |
| `POST /corrections` | 内容平台/社区更正回传 |
| `GET /events?kind=&subject_id=` | 事件日志（审计） |

错误统一为 `{ "error": { "code", "message", "details" } }`；领域冲突返回 409。

## 目录

- `src/poison_misinformation_response.js`：领域术语表（事件种类、行动级别、症状编码等）与事件契约校验。
- `src/triage.js`：分诊规则引擎（纯函数）。
- `src/guidelines.js`：指引版本与生效查询。
- `src/service.js`：应用服务（合并、结案闸门、重评队列、溯源）。
- `src/store.js`：内存存储；生产化时按同名集合替换为数据库实现。
- `src/server.js`：HTTP API。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `tests/`：契约、规则、事件流、指引更新与 HTTP 端到端测试。

## 边界与生产化提示

- 本服务不替代急救调度与临床诊断；行动级别只是给值班人员的分流建议。
- 当前为内存存储，重启即清空；生产化需接入持久化、鉴权与个人信息脱敏（来电人联系方式应按最小必要原则存储）。
