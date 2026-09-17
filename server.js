const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = path.join(__dirname, "data", "db.json");

// 工单非终态：仍占用同曲目的打孔顺序
const ACTIVE_JOB_STATUSES = ["queued", "running", "blocked"];

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
  jobs: [],
  scraps: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/schedule",
  "PATCH /sections/:id/check",
  "POST /sections/:id/jobs",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /jobs",
  "POST /jobs/:id/start",
  "POST /jobs/:id/resume",
  "POST /jobs/:id/complete",
  "POST /jobs/:id/cancel",
  "GET /scraps"
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
  // 兼容旧数据文件：补齐排程相关集合并写回现有文件
  let migrated = false;
  for (const key of ["tunes", "sections", "issues", "jobs", "scraps"]) {
    if (!Array.isArray(db[key])) {
      db[key] = initialData[key] || [];
      migrated = true;
    }
  }
  if (migrated) await writeFile(DB_FILE, JSON.stringify(db, null, 2));
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

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
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

function findSection(db, sectionId) {
  return db.sections.find((item) => item.id === sectionId) || null;
}

function findJob(db, jobId) {
  return db.jobs.find((item) => item.id === jobId) || null;
}

function openIssuesForSection(db, sectionId) {
  return db.issues.filter((item) => item.sectionId === sectionId && item.status !== "resolved");
}

function isJobActive(job) {
  return ACTIVE_JOB_STATUSES.includes(job.status);
}

function compareJobOrder(a, b) {
  // 同一曲目内按起始拍从早到晚，起始拍相同按排程时间
  return a.startBeat - b.startBeat || a.createdAt.localeCompare(b.createdAt);
}

/**
 * 开工/复工前置校验：
 * 1) 区间已试奏核对；2) 无未解决问题；3) 同曲目无打孔中工单（不重叠）；
 * 4) 无起始拍更早的未结束工单（不越序）。
 */
function evaluateStart(db, job) {
  const section = findSection(db, job.sectionId);
  if (!section) return { ok: false, message: "工单对应区间不存在" };
  if (!section.checked) return { ok: false, code: "unchecked", message: "区间尚未通过试奏核对，不能开工" };

  const openIssues = openIssuesForSection(db, job.sectionId);
  if (openIssues.length) {
    const summary = openIssues
      .slice(0, 3)
      .map((item) => item.type || item.id)
      .join("、");
    return {
      ok: false,
      code: "open_issues",
      message: `区间仍有 ${openIssues.length} 个未解决问题（${summary}），不能开工`,
      openIssueIds: openIssues.map((item) => item.id)
    };
  }

  const running = db.jobs.find((item) => item.id !== job.id && item.tuneId === job.tuneId && item.status === "running");
  if (running) {
    return { ok: false, code: "overlap", message: `同曲目工单 ${running.id} 打孔中，不能重叠开工`, blockingJobId: running.id };
  }

  const earlier = db.jobs
    .filter((item) => item.id !== job.id && item.tuneId === job.tuneId && isJobActive(item))
    .filter((item) => item.startBeat < job.startBeat || (item.startBeat === job.startBeat && item.createdAt < job.createdAt));
  if (earlier.length) {
    earlier.sort(compareJobOrder);
    return {
      ok: false,
      code: "out_of_order",
      message: `存在起始拍更早的未结束工单 ${earlier[0].id}（第 ${earlier[0].startBeat} 拍起），不能越序开工`,
      blockingJobId: earlier[0].id
    };
  }

  return { ok: true };
}

// 开工后新增问题 / 改回待核对：停止工单并记录阻塞原因
function blockRunningJob(db, sectionId, reason, blockerIssueId) {
  const job = db.jobs.find((item) => item.sectionId === sectionId && item.status === "running");
  if (!job) return null;
  job.status = "blocked";
  job.blockedAt = new Date().toISOString();
  job.blockReason = reason;
  job.blockerIssueId = blockerIssueId || null;
  return job;
}

function jobView(db, job) {
  const section = findSection(db, job.sectionId);
  const openIssueCount = openIssuesForSection(db, job.sectionId).length;
  const view = {
    ...job,
    section: section
      ? {
          id: section.id,
          startBeat: section.startBeat,
          endBeat: section.endBeat,
          laneRange: section.laneRange,
          checked: section.checked
        }
      : null,
    openIssueCount
  };
  if (job.status === "queued" || job.status === "blocked") {
    view.startCheck = evaluateStart(db, job);
  }
  return view;
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

  // 曲目排程视图：工单按起始拍排序，附带开工校验与废料记录
  const scheduleMatch = pathname.match(/^\/tunes\/([^/]+)\/schedule$/);
  if (scheduleMatch && req.method === "GET") {
    const tuneId = scheduleMatch[1];
    findTune(db, tuneId);
    const jobs = db.jobs
      .filter((item) => item.tuneId === tuneId)
      .sort(compareJobOrder)
      .map((job) => jobView(db, job));
    const scraps = db.scraps.filter((item) => item.tuneId === tuneId);
    return send(res, 200, { data: { tuneId, jobs, scraps } });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = findSection(db, checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    const newChecked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.checked = newChecked;
    section.note = body.note ?? section.note;
    // 开工后改回待核对：工单停止并写出阻塞原因
    const blockedJob = !newChecked
      ? blockRunningJob(db, section.id, `区间被改回待核对（试奏核对状态失效）：${section.note || "未说明原因"}`, null)
      : null;
    await writeDb(db);
    return send(res, 200, { data: section, blockedJob: blockedJob ? jobView(db, blockedJob) : null });
  }

  // 待打孔区间生成工单（进入排队，占用同曲目顺序；开工时才校验核对状态与问题）
  const sectionJobsMatch = pathname.match(/^\/sections\/([^/]+)\/jobs$/);
  if (sectionJobsMatch && req.method === "POST") {
    const section = findSection(db, sectionJobsMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    findTune(db, section.tuneId);
    const duplicate = db.jobs.find((item) => item.sectionId === section.id && isJobActive(item));
    if (duplicate) throw conflict(`该区间已有未结束工单 ${duplicate.id}（状态：${duplicate.status}）`);
    const body = await parseBody(req);
    const job = {
      id: makeId("job"),
      tuneId: section.tuneId,
      sectionId: section.id,
      startBeat: section.startBeat,
      endBeat: section.endBeat,
      laneRange: section.laneRange,
      status: "queued",
      note: body.note || "",
      operator: body.operator || null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      blockedAt: null,
      blockReason: null,
      blockerIssueId: null,
      blockHistory: [],
      cancelledAt: null
    };
    db.jobs.push(job);
    await writeDb(db);
    return send(res, 201, { data: jobView(db, job) });
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
    // 开工后新增问题：工单停止并写出阻塞原因
    const blockedJob = blockRunningJob(
      db,
      body.sectionId,
      `新增问题「${body.type}」：${body.description}`,
      issue.id
    );
    await writeDb(db);
    return send(res, 201, { data: issue, blockedJob: blockedJob ? jobView(db, blockedJob) : null });
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
    // 问题被改回未解决状态：同样停止在打工单（复工需显式调用 resume）
    const blockedJob =
      issue.status !== "resolved"
        ? blockRunningJob(db, issue.sectionId, `未解决问题「${issue.type || issue.id}」：${issue.description}`, issue.id)
        : null;
    await writeDb(db);
    return send(res, 200, { data: issue, blockedJob: blockedJob ? jobView(db, blockedJob) : null });
  }

  if (req.method === "GET" && pathname === "/jobs") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const jobs = db.jobs
      .filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status))
      .sort(compareJobOrder)
      .map((job) => jobView(db, job));
    return send(res, 200, { data: jobs });
  }

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)\/(start|resume|complete|cancel)$/);
  if (jobMatch && req.method === "POST") {
    const job = findJob(db, jobMatch[1]);
    if (!job) return send(res, 404, { error: "工单不存在（已开工取消的工单只保留废料记录）" });
    const action = jobMatch[2];
    const body = await parseBody(req);
    const now = new Date().toISOString();

    if (action === "start") {
      if (job.status !== "queued") throw conflict(`只有未开工工单才能开工，当前状态：${job.status}`);
      const check = evaluateStart(db, job);
      if (!check.ok) throw conflict(check.message);
      job.status = "running";
      job.startedAt = now;
      await writeDb(db);
      return send(res, 200, { data: jobView(db, job) });
    }

    if (action === "resume") {
      if (job.status !== "blocked") throw conflict(`只有已停止（blocked）工单才能复工，当前状态：${job.status}`);
      const check = evaluateStart(db, job);
      if (!check.ok) throw conflict(check.message);
      job.blockHistory.push({
        at: job.blockedAt,
        reason: job.blockReason,
        blockerIssueId: job.blockerIssueId
      });
      job.status = "running";
      job.blockedAt = null;
      job.blockReason = null;
      job.blockerIssueId = null;
      job.resumedAt = now;
      await writeDb(db);
      return send(res, 200, { data: jobView(db, job) });
    }

    if (action === "complete") {
      if (job.status !== "running") throw conflict(`只有打孔中的工单才能完工，当前状态：${job.status}`);
      job.status = "completed";
      job.completedAt = now;
      await writeDb(db);
      return send(res, 200, { data: jobView(db, job) });
    }

    // cancel
    if (job.status === "queued") {
      // 未开工取消：仅作废排队，顺序随即释放
      job.status = "cancelled";
      job.cancelledAt = now;
      job.cancelReason = body.reason || null;
      await writeDb(db);
      return send(res, 200, { data: jobView(db, job), releasedOrder: true });
    }
    if (job.status === "running" || job.status === "blocked") {
      // 已开工取消：删除工单，只保留废料记录
      const scrap = {
        id: makeId("scrap"),
        jobId: job.id,
        tuneId: job.tuneId,
        sectionId: job.sectionId,
        startBeat: job.startBeat,
        endBeat: job.endBeat,
        laneRange: job.laneRange,
        operator: body.operator || job.operator || null,
        reason: body.reason || (job.status === "blocked" ? `阻塞取消：${job.blockReason}` : "开工后取消"),
        startedAt: job.startedAt,
        blockedHistory: job.blockHistory || [],
        lastBlockReason: job.blockReason,
        cancelledAt: now,
        createdAt: now
      };
      db.scraps.push(scrap);
      db.jobs = db.jobs.filter((item) => item.id !== job.id);
      await writeDb(db);
      return send(res, 200, { data: scrap, scrapped: true, releasedOrder: true });
    }
    throw conflict(`工单已结束（${job.status}），无法取消`);
  }

  if (req.method === "GET" && pathname === "/scraps") {
    const tuneId = searchParams.get("tuneId");
    const scraps = db.scraps
      .filter((item) => !tuneId || item.tuneId === tuneId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, { data: scraps });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
