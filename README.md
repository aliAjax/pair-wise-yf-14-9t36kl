# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`
- `GET /tunes/:id/work-orders`
- `POST /tunes/:id/work-orders`（body 带 `sectionId` 生成单个，否则为全部待打孔区间生成）
- `POST /work-orders/:id/start`
- `POST /work-orders/:id/complete`
- `POST /work-orders/:id/cancel`
- `GET /tunes/:id/waste-records`

## 区间排程规则

工单状态：`pending` 待开工 → `active` 开工中 → `completed` 已完工；另有 `blocked` 已停止、`cancelled` 已取消。

- 同一曲目按区间起始拍从早到晚依次开工，不能越序；同时只能有一个工单在开工，不能重叠。
- 只有已试奏核对（`checked`）且没有未解决问题的区间才能开工。
- 开工后新增问题、问题被重新打开或区间被改回待核对时，工单停止为 `blocked` 并写出 `blockReason`；问题解决后可再次 `start` 重新开工。
- 取消未开工工单：标记 `cancelled` 并释放顺序；取消已开工（含已停止）工单：工单移除，只保留一条废料记录（`wasteRecords`）。
- 所有状态写回 `data/db.json`。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```

## 排程闭环示例

```bash
# 为曲目全部待打孔区间生成工单
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/work-orders
# 按起始拍顺序开工（越序/重叠/未核对/有未解决问题都会被拒）
curl -X POST http://127.0.0.1:3019/work-orders/<工单ID>/start
# 完工后下一工单才能开工
curl -X POST http://127.0.0.1:3019/work-orders/<工单ID>/complete
# 取消：未开工释放顺序；已开工只留废料记录
curl -X POST http://127.0.0.1:3019/work-orders/<工单ID>/cancel
curl http://127.0.0.1:3019/tunes/tune_demo/waste-records
```
