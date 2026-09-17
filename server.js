const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ],
  workOrders: [],
  wasteRecords: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /tunes/:id/work-orders",
  "POST /tunes/:id/work-orders",
  "POST /work-orders/:id/start",
  "POST /work-orders/:id/complete",
  "POST /work-orders/:id/cancel",
  "GET /tunes/:id/waste-records"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.workOrders = db.workOrders || [];
  db.wasteRecords = db.wasteRecords || [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

// 工单状态：pending 待开工 / active 开工中 / blocked 已停止 / completed 已完工 / cancelled 已取消
const UNFINISHED_STATUSES = ["pending", "active", "blocked"];

function findSection(db, sectionId) {
  return db.sections.find((item) => item.id === sectionId) || null;
}

function openIssuesOf(db, sectionId) {
  return db.issues.filter((item) => item.sectionId === sectionId && item.status !== "resolved");
}

function sortWorkOrders(db, orders) {
  return [...orders].sort((a, b) => {
    const sectionA = findSection(db, a.sectionId);
    const sectionB = findSection(db, b.sectionId);
    const beatA = sectionA ? sectionA.startBeat : Number.MAX_SAFE_INTEGER;
    const beatB = sectionB ? sectionB.startBeat : Number.MAX_SAFE_INTEGER;
    if (beatA !== beatB) return beatA - beatB;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

function decorateWorkOrder(db, order) {
  return {
    ...order,
    section: findSection(db, order.sectionId),
    openIssues: openIssuesOf(db, order.sectionId).length
  };
}

// 开工后出现阻塞因素时，停止该区间的在开工工单并写出阻塞原因
function blockActiveWorkOrders(db, sectionId, reason) {
  const blockedAt = new Date().toISOString();
  const blocked = [];
  for (const order of db.workOrders) {
    if (order.sectionId === sectionId && order.status === "active") {
      order.status = "blocked";
      order.blockedAt = blockedAt;
      order.blockReason = reason;
      blocked.push(order);
    }
  }
  return blocked;
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    const blocked = section.checked ? [] : blockActiveWorkOrders(db, section.id, "区间被改回待核对");
    await writeDb(db);
    return send(res, 200, { data: section, blockedWorkOrders: blocked.map((item) => item.id) });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    const blocked = blockActiveWorkOrders(db, issue.sectionId, `新增未解决问题「${issue.type}」：${issue.description}`);
    await writeDb(db);
    return send(res, 201, { data: issue, blockedWorkOrders: blocked.map((item) => item.id) });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    const blocked = body.status === "resolved" ? [] : blockActiveWorkOrders(db, issue.sectionId, `问题「${issue.type}」被重新打开：${issue.description}`);
    await writeDb(db);
    return send(res, 200, { data: issue, blockedWorkOrders: blocked.map((item) => item.id) });
  }

  const tuneWorkOrdersMatch = pathname.match(/^\/tunes\/([^/]+)\/work-orders$/);
  if (tuneWorkOrdersMatch && req.method === "GET") {
    const tuneId = tuneWorkOrdersMatch[1];
    findTune(db, tuneId);
    const orders = sortWorkOrders(db, db.workOrders.filter((item) => item.tuneId === tuneId));
    return send(res, 200, { data: orders.map((order) => decorateWorkOrder(db, order)) });
  }

  if (tuneWorkOrdersMatch && req.method === "POST") {
    const tuneId = tuneWorkOrdersMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    const sections = db.sections
      .filter((item) => item.tuneId === tuneId)
      .sort((a, b) => a.startBeat - b.startBeat);
    let targets = sections;
    if (body.sectionId !== undefined) {
      const section = sections.find((item) => item.id === body.sectionId);
      if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
      targets = [section];
    }
    const created = [];
    const skipped = [];
    for (const section of targets) {
      const existing = db.workOrders.find((item) => item.sectionId === section.id && item.status !== "cancelled");
      if (existing) {
        skipped.push({
          sectionId: section.id,
          workOrderId: existing.id,
          reason: existing.status === "completed" ? "区间已完工" : "区间已有工单"
        });
        continue;
      }
      const order = {
        id: makeId("wo"),
        tuneId,
        sectionId: section.id,
        status: "pending",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        blockedAt: null,
        blockReason: null
      };
      db.workOrders.push(order);
      created.push(order);
    }
    if (body.sectionId !== undefined && !created.length) {
      return send(res, 400, { error: skipped[0].reason, workOrderId: skipped[0].workOrderId });
    }
    await writeDb(db);
    return send(res, 201, { data: created.map((order) => decorateWorkOrder(db, order)), skipped });
  }

  const workOrderStartMatch = pathname.match(/^\/work-orders\/([^/]+)\/start$/);
  if (workOrderStartMatch && req.method === "POST") {
    const order = db.workOrders.find((item) => item.id === workOrderStartMatch[1]);
    if (!order) return send(res, 404, { error: "工单不存在" });
    if (order.status === "active") return send(res, 400, { error: "工单已开工，请勿重复开工" });
    if (order.status === "completed") return send(res, 400, { error: "工单已完工，不能开工" });
    if (order.status === "cancelled") return send(res, 400, { error: "工单已取消，不能开工" });
    const section = findSection(db, order.sectionId);
    if (!section) return send(res, 400, { error: "工单对应区间不存在" });
    if (!section.checked) return send(res, 400, { error: "区间未试奏核对，不能开工" });
    const openIssues = openIssuesOf(db, section.id);
    if (openIssues.length) {
      return send(res, 400, {
        error: `区间还有 ${openIssues.length} 个未解决问题，不能开工`,
        openIssues: openIssues.map((item) => item.id)
      });
    }
    const running = db.workOrders.find((item) => item.tuneId === order.tuneId && item.status === "active");
    if (running) return send(res, 400, { error: `工单 ${running.id} 正在开工，同一曲目不能重叠开工` });
    const queue = sortWorkOrders(
      db,
      db.workOrders.filter((item) => item.tuneId === order.tuneId && UNFINISHED_STATUSES.includes(item.status))
    );
    const head = queue[0];
    if (head && head.id !== order.id) {
      const headSection = findSection(db, head.sectionId);
      return send(res, 400, {
        error: `必须按起始拍从早到晚依次开工，请先处理工单 ${head.id}（起始拍 ${headSection ? headSection.startBeat : "未知"}）`
      });
    }
    order.status = "active";
    order.startedAt = new Date().toISOString();
    order.blockedAt = null;
    order.blockReason = null;
    await writeDb(db);
    return send(res, 200, { data: decorateWorkOrder(db, order) });
  }

  const workOrderCompleteMatch = pathname.match(/^\/work-orders\/([^/]+)\/complete$/);
  if (workOrderCompleteMatch && req.method === "POST") {
    const order = db.workOrders.find((item) => item.id === workOrderCompleteMatch[1]);
    if (!order) return send(res, 404, { error: "工单不存在" });
    if (order.status !== "active") return send(res, 400, { error: "只有开工中的工单才能完工" });
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: decorateWorkOrder(db, order) });
  }

  const workOrderCancelMatch = pathname.match(/^\/work-orders\/([^/]+)\/cancel$/);
  if (workOrderCancelMatch && req.method === "POST") {
    const index = db.workOrders.findIndex((item) => item.id === workOrderCancelMatch[1]);
    if (index === -1) return send(res, 404, { error: "工单不存在" });
    const order = db.workOrders[index];
    if (order.status === "completed") return send(res, 400, { error: "工单已完工，不能取消" });
    if (order.status === "cancelled") return send(res, 400, { error: "工单已取消，请勿重复操作" });
    const body = await parseBody(req);
    if (order.status === "pending") {
      order.status = "cancelled";
      order.cancelledAt = new Date().toISOString();
      order.cancelReason = body.reason || "";
      await writeDb(db);
      return send(res, 200, { data: decorateWorkOrder(db, order), message: "未开工工单已取消，顺序已释放" });
    }
    const waste = {
      id: makeId("waste"),
      tuneId: order.tuneId,
      sectionId: order.sectionId,
      workOrderId: order.id,
      startedAt: order.startedAt,
      cancelledAt: new Date().toISOString(),
      lastBlockReason: order.blockReason || null,
      reason: body.reason || "已开工取消，纸带作废",
      createdAt: new Date().toISOString()
    };
    db.wasteRecords.push(waste);
    db.workOrders.splice(index, 1);
    await writeDb(db);
    return send(res, 200, { data: waste, message: "已开工工单已取消，仅保留废料记录" });
  }

  const wasteRecordsMatch = pathname.match(/^\/tunes\/([^/]+)\/waste-records$/);
  if (wasteRecordsMatch && req.method === "GET") {
    const tuneId = wasteRecordsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.wasteRecords.filter((item) => item.tuneId === tuneId) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
