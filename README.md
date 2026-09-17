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
- `POST /issues`（若区间工单打孔中，工单自动停止并写阻塞原因）
- `PATCH /issues/:id/status`（问题改回未解决同样停止在打工单）

## 区间排程

同一曲目的工单必须按区间起始拍从早到晚依次开工，不能越序或重叠；只有**已试奏核对且无未解决问题**的区间才能开工。

工单状态：`queued`（未开工，占顺序）→ `running`（打孔中）→ `completed`；
打孔中新增问题或区间改回待核对会自动转为 `blocked`（停止并记录 `blockReason`），处理完后需显式复工。

- `GET /tunes/:id/schedule` — 曲目排程视图（工单按起始拍排序，含开工校验与废料记录）
- `POST /sections/:id/jobs` — 待打孔区间生成排队工单
- `GET /jobs?tuneId=&status=`
- `POST /jobs/:id/start` — 开工（校验核对状态、未解决问题、重叠与越序）
- `POST /jobs/:id/resume` — 阻塞后复工（重新校验）
- `POST /jobs/:id/complete` — 完工
- `POST /jobs/:id/cancel` — 未开工取消仅作废并释放顺序；已开工取消删除工单只保留废料记录
- `GET /scraps?tuneId=`

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'

# 区间排程闭环：已核对区间 section_demo_1 生成工单并开工
curl -X POST http://127.0.0.1:3019/sections/section_demo_1/jobs
curl -X POST http://127.0.0.1:3019/jobs/<jobId>/start
# 未核对 / 有未解决问题的区间无法开工；打孔中新增问题会自动阻塞
curl http://127.0.0.1:3019/tunes/tune_demo/schedule
```
