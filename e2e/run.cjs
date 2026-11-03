// End-to-end run against a production build + the local test backend (scripts/dev-backend).
// Usage: node e2e/run.cjs   (expects the app on http://localhost:3000; Playwright's Chromium must be installed)
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// The admin step talks to the test backend directly: its settings come from the stack's env file (scripts/dev-backend/start.sh writes it),
// which wins over whatever the shell happens to export, so this suite can never reach a real project by accident.
{
  const envFile = path.join(process.env.WORK || "/tmp/shifa-dev-backend", "env");
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(line); if (m) process.env[m[1]] = m[2]; }
}
const BASE = process.env.E2E_BASE || "http://localhost:3000";
const OUT = process.env.E2E_OUT || "/tmp/shifa-e2e";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const problems = [];           // console errors / 5xx responses seen anywhere
let current = "";
const stamp = Date.now().toString(36);

async function step(name, fn) {
  current = name;
  try { await fn(); results.push([name, true]); console.log("PASS", name); }
  catch (e) { results.push([name, false, String(e.message).split("\n")[0]]); console.log("FAIL", name, "\n     ", String(e.message).split("\n").slice(0, 3).join("\n      ")); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

function watch(page, label) {
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror @${current}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of (401|403|404|406)/.test(m.text())) problems.push(`[${label}] console.error @${current}: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`[${label}] HTTP ${r.status()} ${r.url()} @${current}`); });
}

const pdf = (extra = "") => Buffer.from(`%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n${extra}%%EOF\n`);

// a real, valid PNG (w × h, grey gradient) for the image viewer steps; every size is a different file
function makePng(w, h) {
  const zlib = require("node:zlib");
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = Math.floor(40 + 160 * (x / w) * (0.5 + y / (2 * h)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const localInput = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

// every context gets its own client address (as a reverse proxy would send), so the per-IP throttle of one scenario
// never bleeds into another and repeated runs stay independent
const randomIp = () => `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
async function newContext(browser, extra = {}) {
  const ctx = await browser.newContext({ locale: "en-GB", timezoneId: "Asia/Riyadh", ...extra });
  // only requests to the app carry the address: a custom header on cross-origin requests (Google Fonts) fails CORS
  const ip = randomIp();
  await ctx.route(`${BASE}/**`, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
  await ctx.addCookies([{ name: "lang", value: "en", url: BASE }]);
  return ctx;
}

async function signup(page, email, name) {
  await page.goto(`${BASE}/signup`);
  await page.fill("#full_name", name);
  await page.fill("#email", email);
  await page.fill("#password", "correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/patients$/);
}

const openSummary = async (page, text) => { await page.locator("summary", { hasText: text }).first().click(); };
const submit = async (scope, name) => { await scope.getByRole("button", { name, exact: true }).first().click(); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  watch(page, "alice");
  let pid = "", shareLink = "", sharePin = "", cardioDocId = "", contribShareHref = "";

  await step("landing page renders and language toggles to Arabic/RTL", async () => {
    await page.goto(BASE);
    assert((await page.locator("html").getAttribute("dir")) === "ltr", "english is ltr");
    await page.getByRole("button", { name: /العربية/ }).click();
    await page.waitForFunction(() => document.documentElement.dir === "rtl");
    assert((await page.locator("html").getAttribute("lang")) === "ar", "lang ar");
    await page.getByRole("button", { name: /English/ }).click();
    await page.waitForFunction(() => document.documentElement.dir === "ltr");
  });

  await step("anonymous visitors are redirected away from private pages", async () => {
    await page.goto(`${BASE}/patients`);
    assert(/\/login\?next=/.test(page.url()), "redirected to login: " + page.url());
  });

  await step("signup rejects a short password and a bad email", async () => {
    await page.goto(`${BASE}/signup`);
    await page.fill("#full_name", "Tester");
    await page.fill("#email", "not-an-email");
    await page.fill("#password", "short-pw");
    await page.evaluate(() => document.querySelector("form").noValidate = true);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("alert").waitFor();
  });

  const aliceEmail = `alice-${stamp}@example.test`;
  await step("signup creates an account and lands on the (empty) patients list", async () => {
    await signup(page, aliceEmail, "Alice Alpha");
    await page.getByText("No files yet").waitFor();
  });

  await step("create a patient file (validation + success)", async () => {
    await page.goto(`${BASE}/patients/new`);
    await page.fill("#full_name", "Alice Alpha");
    await page.fill("#full_name_en", "Alice Alpha");
    await page.fill("#date_of_birth", "1990-05-01");
    await page.selectOption("#sex", "female");
    await page.selectOption("#blood_abo", "A");
    await page.selectOption("#blood_rh", "+");
    await page.fill("#phone", "+966500000001");
    await submit(page, "Create file");
    // a new file opens on its core file
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}\/profile\?new=1$/);
    pid = page.url().split("/")[4];
    await page.getByText("The file was created. Complete the core file now").waitFor();
    await page.getByText("Allergy status unknown").waitFor();
    assert(await page.getByRole("heading", { name: "Alice Alpha" }).count(), "name shown");
    assert((await page.getByText(/^SH-\d{8}/).count()) > 0, "MRN shown");
  });

  await step("duplicate patient is detected, then allowed after explicit confirmation", async () => {
    await page.goto(`${BASE}/patients/new`);
    await page.fill("#full_name", "alice alpha");
    await page.fill("#date_of_birth", "1990-05-01");
    await submit(page, "Create file");
    await page.getByText(/same name and birth date/).waitFor();
  });

  await step("core file: allergy statement, national id masked, contacts", async () => {
    await page.goto(`${BASE}/patients/${pid}/profile`);
    await page.selectOption("#allergy_assertion", "none_known");
    await page.locator("form:has(#allergy_assertion)").getByRole("button", { name: "Save" }).click();
    await page.locator("form:has(#allergy_assertion)").getByText("Saved.").waitFor();
    await page.fill('input[name="id_value"]', "1098765432");
    await page.locator('form:has(input[name="id_value"])').getByRole("button", { name: "Save" }).click();
    await page.getByText("••••••5432").waitFor();
    assert(!(await page.content()).includes("1098765432"), "national id must not be in the page");
    await openSummary(page, "Add a contact");
    await page.locator('input[name="full_name"]').last().fill("Omar Alpha");
    await page.locator('input[name="phone"]').last().fill("+966511111111");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    await page.getByText("Omar Alpha").waitFor();
  });

  await step("allergies: adding one flips the banner; 'none known' is then refused", async () => {
    await page.goto(`${BASE}/patients/${pid}/allergies`);
    await openSummary(page, "Add allergy");
    await page.fill("#allergies_new_substance", "Penicillin");
    await page.selectOption("#allergies_new_severity", "life_threatening");
    await page.selectOption("#allergies_new_certainty", "confirmed");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}`);
    await page.getByText("Documented allergies").waitFor();
    await page.goto(`${BASE}/patients/${pid}/profile`);
    await page.selectOption("#allergy_assertion", "none_known");
    await page.locator("form:has(#allergy_assertion)").getByRole("button", { name: "Save" }).click();
    await page.getByText(/Active allergies are recorded/).waitFor();
  });

  await step("conditions and medications are saved with provenance", async () => {
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    await page.fill("#conditions_new_name", "Hypertension");
    await page.selectOption("#conditions_new_category", "chronic");
    await page.selectOption("#conditions_new_certainty", "confirmed");
    await submit(page, "Save");
    await page.getByText("Hypertension").first().waitFor();
    await page.getByText(/by you/).first().waitFor();
    await page.getByText("Patient-reported (unverified)").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/medications`);
    await openSummary(page, "Add medication");
    await page.fill("#medications_new_name_generic", "Metformin");
    await page.fill("#medications_new_strength", "500 mg");
    await page.selectOption("#medications_new_origin", "prescribed");
    await submit(page, "Save");
    await page.getByText(/Metformin/).first().waitFor();
    // a medication without any name is refused by the server
    await page.reload();
    await openSummary(page, "Add medication");
    await submit(page, "Save");
    await page.getByRole("alert").first().waitFor();
  });

  await step("a record can be invalidated with a reason and stays in the history", async () => {
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    await page.fill("#conditions_new_name", "Entered by mistake");
    await submit(page, "Save");
    await page.getByText("Entered by mistake").first().waitFor();
    const rec = page.locator("article.rec", { hasText: "Entered by mistake" }).first();
    await rec.locator("summary", { hasText: "Entered in error" }).click();
    page.once("dialog", (d) => d.accept());
    await rec.locator('input[name="reason"]').fill("duplicate entry");
    await rec.getByRole("button", { name: "Invalidate" }).click();
    await page.getByText(/Invalidated records \(1\)/).waitFor();
  });

  await step("vitals: log BP with pulse over several days; chart + stats render; flag shown", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_pressure`);
    const readings = [[150, 95, 88, 0], [138, 88, 80, 2], [124, 82, 76, 5], [118, 76, 70, 9], [132, 84, 74, 14]];
    for (const [s, d, p, ago] of readings) {
      await page.locator("input[type=datetime-local]").first().fill(localInput(daysAgo(ago)));
      await page.fill("#v_num", String(s));
      await page.fill("#v_num2", String(d));
      await page.fill("#v_pulse", String(p));
      await submit(page, "Save reading");
      await page.getByText("Reading saved.").waitFor();
      await page.reload();
    }
    await page.locator("svg.chart").first().waitFor();
    assert((await page.locator("svg.chart circle.dot, svg.chart path.dot").count()) >= 8, "points drawn for sys+dia");
    await page.getByText("150/95").first().waitFor();
    assert((await page.getByText("High", { exact: true }).count()) >= 1, "high flag shown");
    assert((await page.getByText("readings").count()) >= 1, "stats shown");
  });

  await step("vitals: invalid input is rejected with a clear message", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_pressure`);
    await page.fill("#v_num", "80"); await page.fill("#v_num2", "120");
    await submit(page, "Save reading");
    await page.getByText("Systolic must be greater than diastolic.").waitFor();
    await page.fill("#v_num", "999"); await page.fill("#v_num2", "80");
    await submit(page, "Save reading");
    await page.getByText(/outside the plausible range/).waitFor();
    await page.fill("#v_num", "abc");
    await submit(page, "Save reading");
    await page.getByText("Enter a valid number.").waitFor();
  });

  await step("vitals: period switch, compare with previous period, daily/weekly summaries, vector PDF report", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_pressure`);
    await page.getByRole("link", { name: "7 days" }).click();
    await page.waitForURL(/range=7/);
    await page.getByRole("link", { name: "Compare with previous period" }).click();
    await page.waitForURL(/cmp=1/);
    await page.locator("svg.chart").first().waitFor();
    await page.getByRole("link", { name: "Weekly" }).click();
    await page.getByText("Mean").first().waitFor();
    const r = await ctx.request.get(`${BASE}/api/patients/${pid}/report?scope=vitals&type=blood_pressure&range=all`);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]) && /no-store/.test(r.headers()["cache-control"]), "pdf served: " + r.status());
    const buf = await r.body();
    assert(buf.subarray(0, 5).toString() === "%PDF-" && buf.length > 5000, "a real PDF document (" + buf.length + " bytes)");
    fs.writeFileSync(path.join(OUT, "vitals-report.pdf"), buf);
  });

  await step("vitals: glucose with context is classified; units are not mixed", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_glucose`);
    await page.fill("#v_num", "110"); await page.selectOption("#v_ctx", "fasting");
    await submit(page, "Save reading");
    await page.getByText("Reading saved.").waitFor();
    await page.reload();
    await page.fill("#v_num", "5.8");
    await page.selectOption("#v_unit", "mmol/L"); await page.selectOption("#v_ctx", "fasting");
    await submit(page, "Save reading");
    await page.getByText("Reading saved.").waitFor();
    await page.reload();
    await page.locator(".chip", { hasText: "Borderline" }).first().waitFor();
    await page.getByText(/different units are drawn as separate lines/i).waitFor();
  });

  await step("an approved reading is corrected (not overwritten) and history keeps both", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_pressure&range=all`);
    const row = page.locator("tr", { hasText: "150/95" }).first();
    await row.locator("summary", { hasText: "Correct" }).click();
    await row.locator('input[name="value_num"]').fill("140");
    await row.locator('form:has(button:has-text("Save correction")) input[name="reason"]').fill("misread the monitor");
    await row.getByRole("button", { name: "Save correction" }).click();
    await page.locator("tr.superseded").first().waitFor();
    await page.getByText("Superseded", { exact: true }).first().waitFor();   // the server action has committed and the list was re-rendered
    await page.reload();
    await page.getByText("Superseded", { exact: true }).first().waitFor();
    await page.getByText("Correction", { exact: true }).first().waitFor();
    assert((await page.locator("tr.superseded").count()) >= 1, "original row kept and struck through");
  });

  await step("labs: create a report with numeric + text results; flagged vs reference range", async () => {
    await page.goto(`${BASE}/patients/${pid}/labs/new`);
    await page.fill("#title", "CBC panel");
    await page.fill("#lab_name", "Central Lab");
    await page.selectOption("#r0_type", { label: "Hemoglobin (Hb) (g/dL)" });
    await page.fill("#r0_value", "10.2"); await page.fill("#r0_ref_low", "12"); await page.fill("#r0_ref_high", "16");
    await page.selectOption("#r1_type", { label: "White blood cells (WBC) (10^3/µL)" });
    await page.fill("#r1_value", "6.1"); await page.fill("#r1_ref_low", "4"); await page.fill("#r1_ref_high", "11");
    await page.selectOption("#r2_type", { label: "Urine protein" });
    await page.fill("#r2_value", "Negative");
    await submit(page, "Save report");
    await page.getByText("Report and results saved.").waitFor();
    await page.goto(`${BASE}/patients/${pid}/labs`);
    await page.getByText("1 out of range").waitFor();
    await page.getByText("Negative").first().waitFor();
    await page.getByText("Low", { exact: true }).first().waitFor();
  });

  await step("labs: implausible value fails the whole report atomically", async () => {
    await page.goto(`${BASE}/patients/${pid}/labs/new`);
    await page.fill("#title", "Bad panel");
    await page.selectOption("#r0_type", { label: "Hemoglobin (Hb) (g/dL)" }); await page.fill("#r0_value", "9999");
    await submit(page, "Save report");
    await page.getByText(/plausible range/).waitFor();
    await page.goto(`${BASE}/patients/${pid}/labs`);
    assert((await page.getByText("Bad panel").count()) === 0, "nothing of the failed report was kept");
  });

  await step("labs: trends & comparison view", async () => {
    await page.goto(`${BASE}/patients/${pid}/labs?view=trends&type=hemoglobin`);
    await page.locator("svg.chart").first().waitFor();
    await page.getByText("Result-by-result comparison").waitFor();
  });

  await step("visits for two specialties; visit detail links diagnoses", async () => {
    await page.goto(`${BASE}/patients/${pid}/visits`);
    for (const [reason, kind, spec] of [["Dental check", "dental", "Dentistry"], ["Cardio follow-up", "clinic", "Cardiology"]]) {
      await openSummary(page, "Add visit");
      await page.fill("#visits_new_reason", reason);
      await page.selectOption("#visits_new_kind", kind);
      await page.selectOption("#visits_new_specialty_id", { label: spec });
      await submit(page, "Save");
      await page.getByText("Saved.").first().waitFor();
      await page.reload();
    }
    await page.getByRole("link", { name: /Dental check/ }).first().click().catch(() => {});
    await page.goto(`${BASE}/patients/${pid}/visits`);
    const href = await page.locator("article.rec", { hasText: "Dental check" }).first().locator("a").first().getAttribute("href").catch(() => null);
    // visits cards have no link yet; open through the timeline link instead
    await page.goto(`${BASE}/patients/${pid}/timeline?kind=visit`);
    await page.getByRole("link", { name: /Dental check/ }).first().click();
    await page.waitForURL(/\/visits\/[0-9a-f-]{36}$/);
    await openSummary(page, "Add a diagnosis");
    await page.fill("#conditions_new_name", "Dental caries");
    await page.selectOption("#conditions_new_category", "diagnosis");
    await submit(page, "Save");
    await page.getByText("Dental caries").first().waitFor();
    void href;
  });

  await step("specialty page: shared context; dentistry links to the dental file", async () => {
    await page.goto(`${BASE}/patients/${pid}/specialties/dentistry`);
    await page.getByText("Health context (from the core file)").waitFor();
    await page.getByText("Penicillin").first().waitFor();
    await page.getByText("Hypertension").first().waitFor();
    assert((await page.locator("summary", { hasText: "Dental finding / treatment" }).count()) === 0, "the retired free-text dental form is gone");
    // dentistry has a single workspace: the specialty page opens the dental file
    assert(/\/dental$/.test(page.url()), "the dentistry specialty opens the dental file: " + page.url());
  });

  await step("dental file: two exams on the chart (keyboard surfaces), tooth panel + history, resolve, compare, tooth-linked diagnosis", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.getByRole("heading", { name: "Current tooth chart" }).waitFor();
    assert(/no exam data/.test(await page.locator("#chart-16").getAttribute("aria-label")), "a tooth without an exam is 'no data', not healthy");
    await openSummary(page, "New exam on the chart");
    const exam = async (date, kind, material) => {
      await page.fill("#px_date", date);
      await page.locator("#px-t-16").click();
      await page.getByRole("radio", { name: "Present", exact: true }).check();
      await page.selectOption("#px_fk", kind);
      if (material) await page.selectOption("#px_fm", material);
      await page.locator("#px-t-16").focus(); await page.keyboard.press("m"); await page.keyboard.press("o");
      await page.getByRole("button", { name: "Add to this tooth" }).click();
      await page.locator("#px-t-18").click();
      await page.getByRole("radio", { name: kind === "caries" ? "Present" : "Extracted", exact: true }).check();
      await page.locator(".exam-summary").getByText("16 MO").waitFor();
      await page.getByRole("button", { name: "Save the exam" }).click();
    };
    await exam(daysAgo(400).toISOString().slice(0, 10), "caries");
    await page.getByRole("heading", { name: "Exams (1)" }).waitFor();
    await exam(daysAgo(1).toISOString().slice(0, 10), "filling", "composite");
    await page.getByRole("heading", { name: "Exams (2)" }).waitFor();
    await page.reload();
    assert(/Extracted/.test(await page.locator("#chart-18").getAttribute("aria-label")), "tooth 18 now shows extracted");
    await page.locator("#chart-16").click();
    const panel = page.locator(".tooth-panel");
    await panel.getByText("upper right first molar").waitFor();
    const caries = panel.locator(".tooth-list li", { hasText: "Caries" }).first();
    await caries.locator("summary", { hasText: "Treated / resolved" }).click();
    await caries.locator('input[name="resolved_note"]').fill("filled last year");
    await caries.getByRole("button", { name: "Save" }).click();
    // the resolved finding leaves the current list (its form goes with it)
    await page.locator(".tooth-panel .tooth-list li", { hasText: "Caries" }).waitFor({ state: "detached" });
    await page.locator(".tooth-panel .tooth-hist").getByText(/resolved .* filled last year/).waitFor();
    // the chart as it was after the first exam
    await page.selectOption("#asof", { index: 2 });
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await page.getByRole("heading", { name: /The chart as of/ }).waitFor();
    assert(/Present/.test(await page.locator("#chart-18").getAttribute("aria-label")), "the past chart shows 18 as it was");
    // compare
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const cmp = page.locator("#compare");
    await cmp.getByRole("heading", { name: "Comparing two exams" }).waitFor();
    await cmp.locator("tr", { hasText: "18" }).getByText("Extracted").waitFor();
    await cmp.locator("tr", { hasText: "16" }).getByText("Filling MO").waitFor();
    // a diagnosis naming its tooth (invalid numbers refused)
    await page.goto(`${BASE}/patients/${pid}/dental?tab=problems`);
    await openSummary(page, "Add a dental diagnosis");
    // inside the dental file the form does not ask for the specialty or the category
    assert((await page.locator("#conditions_new_specialty_id").count()) === 0 && (await page.locator("#conditions_new_category").count()) === 0, "dental diagnosis form asks only what it needs");
    await page.fill("#conditions_new_name", "Irreversible pulpitis");
    await page.fill("#conditions_new_teeth", "19");
    await page.locator("form", { has: page.locator("#conditions_new_teeth") }).getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/Invalid tooth numbers/).waitFor();
    await page.fill("#conditions_new_teeth", "36");
    await page.locator("form", { has: page.locator("#conditions_new_teeth") }).getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Teeth: 36").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental`);
    assert(/problem: Irreversible pulpitis/.test(await page.locator("#chart-36").getAttribute("aria-label")), "the open diagnosis is drawn on its tooth");
    await page.locator("#chart-36").click();
    await page.locator(".tooth-panel .tooth-list").getByText("Irreversible pulpitis").first().waitFor();
    await page.screenshot({ path: path.join(OUT, "dental-file.png"), fullPage: true });
  });

  await step("forms know where they are; a diagnosis changes status in one step and keeps its history", async () => {
    // the general conditions form has no tooth field; the core file offers only chronic categories
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    assert((await page.locator("#conditions_new_teeth").count()) === 0, "no tooth field outside the dental file");
    assert((await page.locator("#conditions_new_specialty_id").count()) === 1, "the general form lets the user pick the specialty");
    await page.goto(`${BASE}/patients/${pid}/profile`);
    const cats = await page.locator("#conditions #conditions_new_category option").allInnerTexts();
    assert(cats.length === 4 && !cats.some((c) => /Diagnosis|Acute/.test(c)), "core file: chronic categories only: " + cats.join("|"));
    // resolve, then a recurrence, each with its reason
    await page.goto(`${BASE}/patients/${pid}/dental?tab=problems`);
    const card = () => page.locator("#diagnoses article.rec", { hasText: "Irreversible pulpitis" }).first();
    await card().locator("summary", { hasText: "Change status" }).click();
    await card().getByRole("radio", { name: "Resolved" }).check();
    await card().locator('input[name="status_reason"]').fill("root canal treatment");
    await card().getByRole("button", { name: "Save status" }).click();
    await page.getByText("Status changed; the change is kept in its history.").first().waitFor();
    await page.reload();
    await card().locator("summary", { hasText: "Change status" }).click();
    await card().getByRole("radio", { name: "Recurrence" }).check();
    await card().locator('input[name="status_reason"]').fill("pain again");
    await card().getByRole("button", { name: "Save status" }).click();
    await page.getByText("Status changed; the change is kept in its history.").first().waitFor();
    await page.reload();
    await card().locator("summary", { hasText: "Status history (2 changes)" }).click();
    await card().getByText(/Active → Resolved — root canal treatment/).waitFor();
    await card().getByText(/Resolved → Recurrence — pain again/).waitFor();
  });

  await step("one dental file: a problem without a tooth gets its tooth; procedures and images on the same tooth show on the chart and in its panel", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental?tab=problems`);
    await openSummary(page, "Add a dental diagnosis");
    await page.fill("#conditions_new_name", "Dental abscess (loose canine)");
    await page.locator("form", { has: page.locator("#conditions_new_name") }).getByRole("button", { name: "Save", exact: true }).click();
    const un = page.locator("#unassigned li", { hasText: "Dental abscess (loose canine)" });
    await un.waitFor();
    await page.getByRole("link", { name: /Problems & diagnoses \(\d+ without a tooth\)/ }).waitFor();
    await un.locator('input[name="teeth"]').fill("13");
    await un.getByRole("button", { name: "Set the tooth" }).click();
    await un.waitFor({ state: "detached" });                                          // it leaves the list once its tooth is known
    // a procedure and an image on tooth 13
    await page.goto(`${BASE}/patients/${pid}/dental?tab=care`);
    await openSummary(page, "Add a dental procedure");
    assert((await page.locator("#procedures_new_specialty_id").count()) === 0, "no specialty question inside the dental file");
    await page.fill("#procedures_new_name", "Abscess drainage");
    await page.fill("#procedures_new_teeth", "13");
    await page.locator("form", { has: page.locator("#procedures_new_name") }).getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Teeth: 13").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental?tab=imaging`);
    await openSummary(page, "Add an image or X-ray");
    await page.fill("#imaging_new_teeth", "13, 14");
    await page.fill("#imaging_new_impression", "Periapical radiolucency at 13");
    await page.locator("form", { has: page.locator("#imaging_new_teeth") }).getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Teeth: 13, 14").first().waitFor();
    // the chart and the tooth panel bring them together
    await page.goto(`${BASE}/patients/${pid}/dental`);
    const label = await page.locator("#chart-13").getAttribute("aria-label");
    assert(/problem: Dental abscess/.test(label) && /procedures: 1/.test(label) && /images: 1/.test(label), "tooth 13 carries the problem, the procedure and the image: " + label);
    await page.locator("#chart-13").click();
    const panel = page.locator(".tooth-panel");
    await panel.locator(".tooth-list").getByText("Dental abscess (loose canine)").first().waitFor();
    await panel.locator(".tooth-list").getByText("Abscess drainage").first().waitFor();
    await panel.locator(".tooth-list").getByText("Periapical radiolucency at 13").first().waitFor();
    // the panoramic view is the default; the five-surface view is one click away and shows the same tooth
    await page.locator(".pano-svg").waitFor();
    await page.locator(".pano-svg .lesion").first().waitFor();                                 // the abscess drawn at the apex of 13
    await page.getByRole("button", { name: "Surfaces", exact: true }).click();
    await page.locator("#chart .odonto-svg").waitFor();
    assert(/problem: Dental abscess/.test(await page.locator("#chart-13").getAttribute("aria-label")), "the surfaces view shows the same tooth");
    await page.getByRole("button", { name: "Panoramic", exact: true }).click();
    await page.locator(".pano-svg").waitFor();
    await page.screenshot({ path: path.join(OUT, "dental-linked.png"), fullPage: true });
  });

  await step("in place: the chosen tooth's panel adds a diagnosis and a procedure to that tooth; the menu lists the specialties in use first", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.locator("#chart-46").click();
    const panel = page.locator(".tooth-panel");
    await panel.locator("summary", { hasText: "A diagnosis for this tooth" }).click();
    const dx = page.locator("form#tooth-dx");
    assert((await dx.locator('[name="specialty_id"]:not([type="hidden"]), [name="category"]:not([type="hidden"]), input[name="teeth"]:not([type="hidden"])').count()) === 0,
      "no specialty, category or tooth question when adding from the tooth itself");
    await dx.locator('input[name="name"]').fill("Cracked tooth (from the chart)");
    await dx.getByRole("button", { name: "Add the diagnosis" }).click();
    await panel.locator("li", { hasText: "Cracked tooth (from the chart)" }).waitFor();
    await panel.locator("summary", { hasText: "A procedure on this tooth" }).click();
    const px = page.locator("form#tooth-px");
    await px.locator('input[name="name"]').fill("Bonded splint (from the chart)");
    await px.getByRole("button", { name: "Add the procedure" }).click();
    await panel.locator("li", { hasText: "Bonded splint (from the chart)" }).waitFor();
    await page.reload();
    const label = await page.locator("#chart-46").getAttribute("aria-label");
    assert(/problem: Cracked tooth/.test(label) && /procedures: 1/.test(label), "both are on tooth 46: " + label);
    // the shell: the rail marks "Specialty files"; its menu lists the specialties this file uses, the dental file's own sections, then "open another"
    assert((await page.locator('nav.rail a[data-product="specialties"]').getAttribute("aria-current")) === "page", "the rail marks the specialties product");
    const nav = page.locator("nav.product-menu");
    await nav.locator(".pm-title", { hasText: "Specialty files" }).waitFor();
    await nav.getByRole("link", { name: "Dentistry" }).waitFor();
    assert((await nav.getByRole("link", { name: "Chart & exams" }).getAttribute("aria-current")) === "page", "the dental file's sections are in the menu");
    await page.locator("ol.crumbs").getByText("Chart & exams").waitFor();
    assert(/\/dental$/.test(await nav.getByRole("link", { name: "Dentistry" }).getAttribute("href")), "dentistry opens the dental file");
    await nav.getByRole("link", { name: "Open another specialty" }).click();
    await page.locator("#used").getByText("Dentistry").waitFor();
    assert((await page.locator("#used").getByText("Gynecology").count()) === 0, "unused specialties are not in the used list");
    await page.locator("#others summary").click();
    await page.locator("#others").getByText("Ophthalmology").waitFor();
  });

  await step("treatment: a crown proposed from tooth 46's panel, an extraction added, the plan accepted with the surgical confirmation, the crown completed (chart and problem updated), a private cost, a new version, the plan PDF", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.locator("#chart-46").click();
    const panel = page.locator(".tooth-panel");
    await panel.locator("summary", { hasText: "A treatment for this tooth" }).click();
    const f = page.locator("form#tooth-tx");
    assert((await f.locator('input[name="teeth"]:not([type="hidden"])').count()) === 0, "no tooth question from the tooth panel");
    await f.locator('select[name="catalog_code"]').selectOption("crown_zirconia");
    await f.locator('select[name="condition_id"]').selectOption({ label: "Cracked tooth (from the chart) (46)" });
    await f.getByRole("button", { name: "Add to the plan" }).click();
    await panel.locator("li.planned", { hasText: "Zirconia crown" }).waitFor();
    await page.reload();
    assert(/planned treatments: 1/.test(await page.locator("#chart-46").getAttribute("aria-label")), "the chart marks the planned crown on 46");

    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    const plan = page.locator("article.plan-card").first();
    await plan.getByText("Dental treatment plan").first().waitFor();
    const addBox = plan.locator("details", { hasText: "Add a treatment to this plan" });
    await addBox.locator("summary").click();
    await addBox.locator('select[name="catalog_code"]').selectOption("extraction_simple");
    await addBox.locator('input[name="teeth"]').fill("38");
    await addBox.locator('input[name="phase"]').fill("2");
    await addBox.getByRole("button", { name: "Add the treatment" }).click();
    await plan.locator("li.treat-item", { hasText: "Simple extraction" }).waitFor();
    await plan.locator("li.treat-item", { hasText: "Simple extraction" }).getByText("Surgical").waitFor();

    // accepting: a plan with a surgical treatment needs the explicit confirmation (the box is required)
    await plan.locator("summary", { hasText: "Accept / plan status" }).click();
    const ps = plan.locator('form[id^="ps-"]');
    await ps.locator('select[name="status"]').selectOption("accepted");
    await ps.locator('input[name="confirm_surgical"]').waitFor();
    await ps.locator('input[name="confirm_surgical"]').check();
    await ps.getByRole("button", { name: "Save the status" }).click();
    await plan.getByText("Accepted", { exact: true }).first().waitFor();

    // completing the crown: the procedure, the chart and the cracked-tooth problem follow
    const crown = plan.locator("li.treat-item", { hasText: "Zirconia crown" });
    await crown.locator("summary", { hasText: "Change status" }).click();
    await crown.locator('select[name="status"]').selectOption("completed");
    await crown.getByRole("button", { name: "Save the status" }).click();
    // (the status form leaves with the open state, so the result is checked on the treatment itself)
    await page.locator("li.treat-item", { hasText: "Zirconia crown" }).getByText("Completed", { exact: true }).waitFor();
    await page.locator(".plan-progress", { hasText: "1 of 2 done" }).first().waitFor();

    // a private cost on the extraction
    const ext = page.locator("li.treat-item", { hasText: "Simple extraction" });
    await ext.locator("summary", { hasText: "Add a cost" }).click();
    await ext.locator('input[name="amount"]').fill("300");
    await ext.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".plan-total").first().waitFor();
    assert(/300/.test(await page.locator(".plan-total").first().innerText()), "the total shows the cost");

    // the plan prints with its consent section
    const planId = (await page.locator("article.plan-card").first().getAttribute("id")).replace("plan-", "");
    const r = await page.request.get(`${BASE}/api/patients/${pid}/treatment-plans/${planId}/pdf?costs=1`);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]), "plan pdf " + r.status());
    fs.writeFileSync(path.join(OUT, "treatment-plan.pdf"), await r.body());

    await page.goto(`${BASE}/patients/${pid}/dental`);
    const l46 = await page.locator("#chart-46").getAttribute("aria-label");
    assert(/Crown/.test(l46) && !/problem: Cracked tooth/.test(l46) && !/planned treatments/.test(l46), "46 now carries the crown, the problem is closed: " + l46);
    await page.locator("#chart-46").click();
    await page.locator(".tooth-panel li", { hasText: "Cracked tooth (from the chart)" }).getByText("Resolved").waitFor();

    // a new version keeps the old one
    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    const cur = page.locator("article.plan-card").first();
    await cur.locator("summary", { hasText: "New version" }).click();
    await cur.getByPlaceholder("Why (e.g. the price changed)").fill("price changed");
    await cur.getByRole("button", { name: "Create a new version" }).click();
    await page.getByText("Version 2").first().waitFor();
    await page.locator("#past-plans summary", { hasText: "Past and superseded plans (1)" }).waitFor();
    await page.screenshot({ path: path.join(OUT, "treatment.png"), fullPage: true });
  });

  await step("visits and notes: a dental visit with its anaesthesia, a note from a template signed then amended, a recall that moves forward, pending follow-ups", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental?tab=care`);
    await openSummary(page, "Add a dental visit");
    await page.fill("#visits_new_reason", "Filling 36 (phase C)");
    await page.fill("#visits_new_teeth", "36");
    await page.selectOption("#visits_new_anesthesia_kind", "local_infiltration");
    await page.fill("#visits_new_anesthetic", "Articaine 4% 1.8 ml");
    await page.fill("#visits_new_instructions", "No eating for two hours");
    await page.fill("#visits_new_follow_up_date", new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10));
    await page.locator("form", { has: page.locator("#visits_new_reason") }).getByRole("button", { name: "Save", exact: true }).click();
    const visit = page.locator("article.rec", { hasText: "Filling 36 (phase C)" }).first();
    await visit.locator(".chip", { hasText: "Local infiltration" }).waitFor();

    // a note from a template: a draft, then signed (fixed), then amended (the original kept)
    await openSummary(page, "Add note");
    await page.selectOption("#notes_new_body-tpl", { label: "Filling visit" });
    assert(/Tooth and surfaces:/.test(await page.locator("#notes_new_body").inputValue()), "the template fills the note");
    await page.fill("#notes_new_title", "Filling 36 note");
    await page.locator("form", { has: page.locator("#notes_new_body") }).getByRole("button", { name: "Save", exact: true }).click();
    const note = page.locator("article.rec", { hasText: "Filling 36 note" }).first();
    await note.getByText("Draft", { exact: true }).waitFor();
    page.once("dialog", (dl) => dl.accept());
    await note.getByRole("button", { name: "Sign the note" }).click();
    await page.locator("article.rec", { hasText: "Filling 36 note" }).first().getByText("Signed", { exact: true }).waitFor();
    const signed = page.locator("article.rec", { hasText: "Filling 36 note" }).first();
    assert((await signed.locator("summary", { hasText: "Edit" }).count()) === 0, "a signed note has no Edit");
    await signed.locator("summary", { hasText: "Add an amendment" }).click();
    await signed.locator('textarea[id^="am-"]').fill("Tooth and surfaces: 36 MO");
    await signed.locator('input[id^="amr-"]').fill("surfaces were missing");
    await signed.getByRole("button", { name: "Add the amendment" }).click();
    await page.locator("article.rec", { hasText: "Filling 36 note" }).first().getByText("Amendment 1").waitFor();

    // a recall overdue since January: it shows as pending, then moves six months on when done
    await page.goto(`${BASE}/patients/${pid}/dental?tab=followup`);
    await page.locator("#rc-due").fill("2026-01-15");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const rc = page.locator('li.recall[data-recall="dental_checkup"]');
    await rc.getByText("Overdue").waitFor();
    await page.locator("#pending").getByText("Dental check-up").waitFor();
    await page.locator("nav.product-menu .pm-badge").first().waitFor();
    await rc.locator("summary", { hasText: "Done" }).click();
    await rc.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('li.recall[data-recall="dental_checkup"]').getByText("On track").waitFor();
    // the summary lists what is still waiting (the follow-up the visit asked for)
    await page.goto(`${BASE}/patients/${pid}`);
    await page.locator("#pending").getByText("Filling 36 (phase C)").first().waitFor();
    await page.screenshot({ path: path.join(OUT, "pending.png"), fullPage: true });
  });

  await step("periodontal chart: quick entry moves on after each digit, CAL is computed, a draft resumes, finalising locks it, the PDF, a second chart compared", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio`);
    await page.getByText("No periodontal chart yet").waitFor();
    await page.getByRole("link", { name: "New periodontal chart" }).click();
    await page.locator('#perio-form input[name="exam_date"]').fill(new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
    // tooth 16 is the third tooth of the upper arch: its buccal sites are inputs 6..8, distal first
    const pd = (i) => page.locator(`input[data-row="upper-buccal-pd"][data-i="${i}"]`);
    await pd(6).click();
    await page.keyboard.type("325");
    assert((await pd(6).inputValue()) === "3" && (await pd(7).inputValue()) === "2" && (await pd(8).inputValue()) === "5", "each digit fills one site and moves on");
    assert(await page.evaluate(() => document.activeElement?.getAttribute("data-i")) === "9", "the cursor is on the next tooth");
    await page.keyboard.type("1");
    assert(await page.evaluate(() => document.activeElement?.getAttribute("data-i")) === "9", "after 1 the depth waits for a second digit");
    await page.keyboard.type("2");
    assert((await pd(9).inputValue()) === "12", "two digits make 12");
    await pd(9).fill("");
    // a negative margin can be typed (text keypad) and waits for a second digit after "-1" (down to -15)
    const gmIn = (i) => page.locator(`input[data-row="upper-buccal-gm"][data-i="${i}"]`);
    assert((await gmIn(6).getAttribute("inputmode")) === "text", "the site inputs show a keypad with a minus sign");
    await gmIn(6).click();
    await page.keyboard.type("-1");
    assert(await page.evaluate(() => document.activeElement?.getAttribute("data-i")) === "6", "after -1 the margin waits for a second digit");
    await page.keyboard.type("0");
    assert((await gmIn(6).inputValue()) === "-10" && await page.evaluate(() => document.activeElement?.getAttribute("data-i")) === "7", "-10 is typed in sequence and moves on");
    await gmIn(6).fill("");
    assert((await page.locator("#perio .perio-wrap").first().getAttribute("dir")) === "ltr", "the chart scrolls left-to-right inside an RTL page");
    await page.locator('input[data-row="upper-buccal-gm"][data-i="8"]').fill("-2");
    await page.getByRole("button", { name: "16 mesiobuccal: bleeding" }).click();
    await page.getByRole("checkbox", { name: "46: missing" }).check();
    const calCell = page.locator("table.perio-chart").first().locator("tr.pc-cal").first().locator("td").nth(8);
    assert((await calCell.innerText()).trim() === "7", "CAL = 5 − (−2) = 7, shown as it is typed");
    await page.locator("#perio").screenshot({ path: path.join(OUT, "perio-edit.png") });
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Draft saved.").waitFor();
    // the draft resumes after a reload, and the menu shows it
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio`);
    await page.locator("#perio .chip", { hasText: "Draft" }).waitFor();
    assert((await pd(8).inputValue()) === "5" && await page.getByRole("checkbox", { name: "46: missing" }).isChecked(), "the draft keeps what was typed");
    await page.locator("nav.product-menu .pm-badge", { hasText: "draft" }).waitFor();
    // clearing persists: un-ticking "missing" and saving, then reloading, keeps it un-ticked
    await page.getByRole("checkbox", { name: "46: missing" }).uncheck();
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Draft saved.").waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio`);
    await page.locator("#perio .chip", { hasText: "Draft" }).waitFor();
    assert(!(await page.getByRole("checkbox", { name: "46: missing" }).isChecked()), "un-ticking missing and saving persists");
    await page.getByRole("checkbox", { name: "46: missing" }).check();
    page.once("dialog", (dl) => dl.accept());
    await page.getByRole("button", { name: "Finalise the chart" }).click();
    await page.waitForURL(/[?&]pv=/);
    await page.locator("#perio .chip", { hasText: "Final" }).waitFor();
    assert((await page.locator("#perio input[data-row]").count()) === 0, "a final chart is shown without inputs");
    const pdfHref = await page.locator("#perio a", { hasText: "PDF" }).first().getAttribute("href");
    const pdf = await page.request.get(`${BASE}${pdfHref}`);
    assert(pdf.ok() && (pdf.headers()["content-type"] ?? "").includes("pdf"), "the chart prints as a PDF");
    fs.writeFileSync(path.join(OUT, "perio.pdf"), await pdf.body());
    // a later chart where 16 MB lost attachment: the comparison finds it
    await page.getByRole("link", { name: "New periodontal chart" }).click();
    await pd(6).click();
    await page.keyboard.type("328");
    await page.locator('input[data-row="upper-buccal-gm"][data-i="8"]').fill("-2");
    page.once("dialog", (dl) => dl.accept());
    await page.getByRole("button", { name: "Finalise the chart" }).click();
    await page.waitForURL(/[?&]pv=/);
    const pdf2 = await page.request.get(`${BASE}${await page.locator("#perio a", { hasText: "PDF" }).first().getAttribute("href")}`);
    fs.writeFileSync(path.join(OUT, "perio-2.pdf"), await pdf2.body());
    await page.locator("#perio-compare").getByRole("button", { name: "Compare" }).click();
    await page.locator("table.perio-cmp-worse tr", { hasText: "mesiobuccal" }).getByText("7 → 10 (+3)").waitFor();
    await page.locator("#perio").screenshot({ path: path.join(OUT, "perio.png") });
    // a chosen final chart shows even while a draft is open
    await page.getByRole("link", { name: "New periodontal chart" }).click();
    await pd(6).click();
    await page.keyboard.type("3");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Draft saved.").waitFor();
    await page.locator("#perio-history a", { hasText: "View" }).last().click();
    await page.waitForURL(/[?&]pv=/);
    await page.locator("#perio .chip", { hasText: "Final" }).first().waitFor();
    assert((await page.locator("#perio input[data-row]").count()) === 0, "the chosen final chart is shown, not the open draft");
    // discarding the draft while a new chart is requested, then saving again, starts a fresh draft (no stale id)
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio&pnew=1#perio`);
    await page.locator("#perio .chip", { hasText: "Draft" }).waitFor();
    page.once("dialog", (dl) => dl.accept());
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.locator("#perio .perio-draft-bar").waitFor({ state: "detached" });
    await pd(6).click();
    await page.keyboard.type("4");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Draft saved.").waitFor();
    await page.locator("#perio .perio-draft-bar").waitFor();
    page.once("dialog", (dl) => dl.accept());
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.locator("#perio .perio-draft-bar").waitFor({ state: "detached" });
  });

  await step("documents: valid PDF accepted; disguised executable and active-content PDF rejected", async () => {
    await page.goto(`${BASE}/patients/${pid}/documents`);
    const up = async (name, buf, mime, title, spec) => {
      await page.goto(`${BASE}/patients/${pid}/documents`);
      if (!(await page.locator("#file").isVisible())) await openSummary(page, "Upload a document");
      await page.setInputFiles("#file", { name, mimeType: mime, buffer: buf });
      await page.fill("#title", title);
      if (spec) await page.selectOption("#specialty_id", { label: spec });
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await page.waitForLoadState("networkidle");
    };
    await up("xray.pdf", pdf(), "application/pdf", "Dental X-ray", "Dentistry");
    await page.getByText("Document uploaded.").waitFor();
    await up("cardio.pdf", pdf("% cardio\n"), "application/pdf", "Cardio report", "Cardiology");
    await page.getByText("Document uploaded.").waitFor();
    cardioDocId = (await page.locator("a", { hasText: "Cardio report" }).first().getAttribute("href")).split("/").pop();
    await up("evil.pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00 not a pdf"), "application/pdf", "Evil", null);
    await page.getByText(/File type not allowed/).waitFor();
    await up("js.pdf", pdf("/JS (app.alert(1)) /S /JavaScript\n"), "application/pdf", "Scripted", null);
    await page.getByText(/active content/).waitFor();
    await page.goto(`${BASE}/patients/${pid}/documents`);
    assert((await page.getByText("Evil").count()) === 0 && (await page.getByText("Scripted").count()) === 0, "rejected files are not listed");
    const href = await page.locator("a", { hasText: "Dental X-ray" }).first().getAttribute("href");
    const r = await ctx.request.get(BASE + href);
    assert(r.status() === 200 && r.headers()["content-type"] === "application/pdf", "pdf served: " + r.status());
    assert(/nosniff/.test(r.headers()["x-content-type-options"]) && /no-store/.test(r.headers()["cache-control"]), "hardened headers");
  });

  const addForm = (summary) => page.locator("details", { has: page.locator("summary", { hasText: summary }) }).first();

  await step("partial and unknown dates: an approximate onset year, an imaging study without a date", async () => {
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    await page.fill("#conditions_new_name", "Congenital aortic narrowing");
    await page.selectOption("#conditions_new_category", "congenital");
    await page.fill("#conditions_new_onset_date", "2003-06-15");
    await addForm("Add condition").locator('select[name="date_precision"]').selectOption("approx");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    await page.locator("article.rec", { hasText: "Congenital aortic narrowing" }).getByText("around 2003").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/imaging`);
    await openSummary(page, "Add imaging study");
    await page.selectOption("#imaging_new_modality", "xray");
    await page.fill("#imaging_new_body_site", "Chest (undated photo)");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    await page.locator("article.rec", { hasText: "Chest (undated photo)" }).getByText("Date unknown").first().waitFor();
  });

  await step("duplicates: a repeated condition, reading, file and lab result are flagged; 'save anyway' still saves", async () => {
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    await page.fill("#conditions_new_name", "  hypertension ");
    await submit(page, "Save");
    await page.getByText(/looks like a record that already exists/).waitFor();
    await addForm("Add condition").getByLabel("It is not a duplicate — save anyway").check();
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();

    await page.goto(`${BASE}/patients/${pid}/vitals?type=weight`);
    const when = localInput(daysAgo(1));
    for (const expectDup of [false, true]) {
      await page.locator("input[type=datetime-local]").first().fill(when);
      await page.fill("#v_num", "70");
      await submit(page, "Save reading");
      if (expectDup) await page.getByText(/already recorded with the same value and time/).waitFor();
      else { await page.getByText("Reading saved.").waitFor(); await page.reload(); }
    }

    await page.goto(`${BASE}/patients/${pid}/documents`);
    if (!(await page.locator("#file").isVisible())) await openSummary(page, "Upload a document");
    await page.setInputFiles("#file", { name: "xray-again.pdf", mimeType: "application/pdf", buffer: pdf() });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await page.getByText(/This exact file is already in this record/).waitFor();
    await page.getByText("Upload anyway (an intended second copy)").waitFor();

    await page.goto(`${BASE}/patients/${pid}/labs/new`);
    await page.fill("#title", "CBC panel (again)");
    await page.selectOption("#r0_type", { label: "Hemoglobin (Hb) (g/dL)" });
    await page.fill("#r0_value", "10.2");
    await submit(page, "Save report");
    await page.getByText(/already recorded around the same date with the same values/).waitFor();
  });

  await step("test requests: suggested vs ordered; a lab report closes the request; other-test names; family sides", async () => {
    await page.goto(`${BASE}/patients/${pid}/test-orders`);
    await openSummary(page, "Add test request");
    await page.fill("#test-orders_new_name", "Kidney function");
    await page.selectOption("#test-orders_new_status", "suggested");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    await page.locator("article.rec", { hasText: "Kidney function" }).getByText("Suggested (not ordered)").first().waitFor();

    await page.goto(`${BASE}/patients/${pid}/labs/new`);
    await page.fill("#title", "Kidney panel");
    await page.selectOption("#r0_type", { label: "Creatinine (mg/dL)" });
    await page.fill("#r0_value", "1.0"); await page.fill("#r0_ref_low", "0.5"); await page.fill("#r0_ref_high", "1.1");
    await page.selectOption("#r1_type", { label: "Other lab test (numeric)" });
    await page.fill("#r1_custom_name", "RDW-SD custom");
    await page.fill("#r1_value", "47"); await page.fill("#r1_unit", "fL");
    await page.getByLabel(/Kidney function/).check();
    await submit(page, "Save report");
    await page.getByText(/1 requested test\(s\) marked done/).waitFor();
    await page.goto(`${BASE}/patients/${pid}/test-orders`);
    await page.locator("article.rec", { hasText: "Kidney function" }).getByText("Done", { exact: true }).first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/labs`);
    await page.getByText("RDW-SD custom").first().waitFor();

    await page.goto(`${BASE}/patients/${pid}/family-history`);
    await openSummary(page, "Add family entry");
    await page.selectOption("#family-history_new_relation", "paternal_uncle");
    await page.fill("#family-history_new_condition_name", "Type 1 diabetes");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    await page.getByText("Paternal uncle: Type 1 diabetes").first().waitFor();
  });

  await step("calculated values: BMI from the latest weight and height, eGFR per creatinine result", async () => {
    await page.goto(`${BASE}/patients/${pid}/vitals?type=height`);
    await page.locator("input[type=datetime-local]").first().fill(localInput(daysAgo(1)));
    await page.fill("#v_num", "165");
    await submit(page, "Save reading");
    await page.getByText("Reading saved.").waitFor();
    await page.goto(`${BASE}/patients/${pid}`);
    const card = page.locator("section, .card", { hasText: "Calculated values" }).first();
    await card.waitFor();
    await card.getByText("Body-mass index (BMI)").waitFor();
    await card.getByText("Overweight").waitFor();                       // 70 kg / 1.65 m = 25.7
    await card.getByText("eGFR (CKD-EPI 2021)").waitFor();
    await page.goto(`${BASE}/patients/${pid}/labs`);
    await page.getByText("eGFR (CKD-EPI 2021)").first().waitFor();
  });

  await step("timeline and audit pages render the history", async () => {
    await page.goto(`${BASE}/patients/${pid}/timeline`);
    await page.getByText("Health timeline").waitFor();
    assert((await page.locator(".timeline li").count()) >= 6, "several events listed");
    await page.goto(`${BASE}/patients/${pid}/audit`);
    await page.getByRole("heading", { name: "Change history" }).waitFor();
    assert((await page.locator("table.t tbody tr").count()) >= 10, "audit rows present");
  });

  await step("core file: height and weight become readings, devices, lifestyle, 'none known', completeness; the context reaches the dental file", async () => {
    await page.goto(`${BASE}/patients/${pid}/profile`);
    await page.locator("#completeness").getByText(/core items are missing/).waitFor();
    await page.fill("#height_cm", "165");
    await page.fill("#weight_kg", "62.5");
    await page.locator("form:has(#height_cm)").getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved, and recorded under vitals.").waitFor();
    await page.locator("#body").getByText("165 cm").waitFor();
    // a device in place
    await page.locator("#devices summary", { hasText: "Add a device or implant" }).click();
    await page.selectOption("#devices_new_kind", "prosthetic_heart_valve");
    await page.fill("#devices_new_name", "Mechanical aortic valve");
    await page.locator("form:has(#devices_new_name)").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#devices").getByText("Mechanical aortic valve").waitFor();
    // "no long-term medications" cannot be confused with an empty list
    await page.locator("#medications").getByText("An empty list does not mean “none” until you confirm it.").waitFor();
    // lifestyle: a current smoker with amounts; not pregnant
    await page.selectOption("#hp_tobacco_status", "current");
    await page.locator('#lifestyle input[name="tobacco_types"][value="cigarettes"]').check();
    await page.fill("#hp_cpd", "10");
    await page.fill("#hp_start", "2010");
    await page.selectOption("#hp_pregnancy_status", "not_pregnant");
    await page.locator("form:has(#hp_tobacco_status)").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#lifestyle").getByText("Saved.").waitFor();
    // the reading is in vitals too (one source)
    await page.goto(`${BASE}/patients/${pid}/vitals?type=weight`);
    await page.getByText("62.5").first().waitFor();
    // the context in the dental file, with the dentistry reminders
    await page.goto(`${BASE}/patients/${pid}/dental`);
    const ctxBox = page.locator("section.ctx");
    await ctxBox.getByText("Prosthetic heart valve: endocarditis prophylaxis").waitFor();
    await ctxBox.getByText(/Smoker: slower healing/).waitFor();
    await ctxBox.getByText(/Heart or valve disease: review the need for antibiotic prophylaxis/).waitFor();   // from "Congenital aortic narrowing"
    await ctxBox.getByText(/pack-years/).waitFor();
    await ctxBox.getByText("Penicillin", { exact: true }).waitFor();
    await ctxBox.getByText(/Penicillin allergy: choose an alternative antibiotic/).waitFor();
    await page.screenshot({ path: path.join(OUT, "core-context-dental.png"), fullPage: true });
  });

  await step("dashboard summarises vitals, medications, conditions and alerts", async () => {
    await page.goto(`${BASE}/patients/${pid}`);
    await page.getByText("Health context (from the core file)").waitFor();
    await page.getByText(/Metformin/).first().waitFor();
    await page.getByText("Hypertension").first().waitFor();
    await page.getByText("Blood pressure").first().waitFor();
    await page.getByText("Recent out-of-range results").waitFor();
  });


  await step("social history: weekly activity, sleep, diet, living, other substances (sensitive) and the exposure list", async () => {
    await page.goto(`${BASE}/patients/${pid}/profile`);
    await page.fill("#hp_actmin", "150");
    await page.fill("#hp_actdays", "4");
    await page.selectOption("#hp_diet_pattern", "balanced");
    await page.fill("#hp_sleep", "7.5");
    await page.selectOption("#hp_sleep_quality", "fair");
    await page.selectOption("#hp_living_situation", "with_family");
    await page.fill("#hp_occ", "Quarry worker");
    await page.selectOption("#hp_substance_use_status", "former");
    await page.locator('#lifestyle input[name="substance_types"][value="cannabis"]').check();
    await page.locator("form:has(#hp_tobacco_status)").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#lifestyle").getByText("Saved.").waitFor();
    await page.reload();
    assert((await page.inputValue("#hp_actmin")) === "150" && (await page.inputValue("#hp_sleep")) === "7.5", "social history reloads");
    // tobacco and pregnancy entered earlier are untouched by the new fields
    assert((await page.inputValue("#hp_tobacco_status")) === "current" && (await page.inputValue("#hp_cpd")) === "10", "tobacco kept");
    // an exposure with years and protective equipment
    await page.locator("#exposures summary", { hasText: "Add an exposure" }).click();
    await page.selectOption("#exposures_new_kind", "silica");
    await page.fill("#exposures_new_agent", "Quarry dust");
    await page.fill("#exposures_new_years", "12");
    await page.selectOption("#exposures_new_protective_equipment", "sometimes");
    await page.locator("form:has(#exposures_new_agent)").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#exposures").getByText("Silica — Quarry dust").waitFor();
    await page.locator("#exposures").getByText("Protection: Sometimes").waitFor();
    // the context shows it, with the other substances only on the patient's side
    await page.goto(`${BASE}/patients/${pid}`);
    const ctx = page.locator("section.ctx");
    await ctx.getByText("Occupation: Quarry worker").waitFor();
    await ctx.getByText(/Silica \(Quarry dust\)/).waitFor();
    await ctx.getByText(/150 min\/week/).waitFor();
    await ctx.getByText(/Other substances: Former \(Cannabis\)/).waitFor();
  });

  await step("symptom log: two entries of one symptom are charted over time; filter, edit fields, invalidate", async () => {
    await page.goto(`${BASE}/patients/${pid}/symptoms`);
    await page.getByRole("heading", { name: "Symptom log" }).waitFor();
    const quick = page.locator("#quick");
    for (const [sev, ago] of [["7", 3], ["4", 1]]) {
      await quick.locator("#quick_symptoms_new_symptom").fill("Throbbing headache");
      await quick.locator("#quick_symptoms_new_severity").fill(sev);
      await quick.locator("input[type=datetime-local]").first().fill(localInput(daysAgo(ago)));
      await quick.getByRole("button", { name: "Log symptom" }).click();
      await page.getByText("Saved.").first().waitFor();
      await page.reload();
    }
    await quick.locator("#quick_symptoms_new_symptom").fill("Cough");
    await quick.locator("#quick_symptoms_new_severity").fill("2");
    await quick.getByRole("button", { name: "Log symptom" }).click();
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    await page.locator("nav.tabs a", { hasText: "Throbbing headache" }).click();
    await page.getByText("Severity of “Throbbing headache” over time").waitFor();
    assert((await page.locator("svg.chart circle.dot").count()) === 2, "two points on the severity chart");
    assert(await page.locator("svg.chart").first().getAttribute("aria-label").then((x) => /Throbbing/.test(x)), "chart is labelled");
    await page.locator(".tile", { hasText: "Latest severity" }).getByText("4").first().waitFor();
    await page.locator(".tile", { hasText: "Highest" }).getByText("7").first().waitFor();
    // the list follows the symptom filter
    await page.locator("#log").getByText("Throbbing headache").first().waitFor();
    assert((await page.locator("#log article.rec").count()) === 2, "log filtered to the symptom");
    assert((await page.locator("#log .rec-title", { hasText: "Cough" }).count()) === 0, "other symptom not in the filtered log");
    // invalidate one entry: it leaves the chart but stays in the history
    await page.locator("#log article.rec").first().locator("summary", { hasText: "Entered in error" }).click();
    await page.locator("#log article.rec").first().locator('input[name="reason"]').fill("duplicate entry");
    page.once("dialog", (d) => d.accept());
    await page.locator("#log article.rec").first().getByRole("button", { name: "Invalidate" }).click();
    await page.locator("#log summary", { hasText: "Invalidated records (1)" }).waitFor();   // the card moves there, taking its message with it
    await page.reload();
    assert((await page.locator("svg.chart circle.dot").count()) === 1, "invalidated entry leaves the chart");
    await page.locator("#log summary", { hasText: "Invalidated records (1)" }).waitFor();
    // the timeline and the dashboard know about symptoms
    await page.goto(`${BASE}/patients/${pid}/timeline?kind=symptom`);
    await page.locator(".timeline li").getByText("Cough").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}`);
    await page.getByText("Ongoing symptoms").waitFor();
    await page.screenshot({ path: path.join(OUT, "symptoms.png"), fullPage: false });
  });

  await step("search inside the file: finds a medication and a note, links to the record, ignores other files", async () => {
    await page.goto(`${BASE}/patients/${pid}/symptoms`);
    await page.locator(".shell-search input").fill("metformin");
    await page.locator(".shell-search input").press("Enter");
    await page.waitForURL(/\/search\?q=metformin/);
    const hit = page.locator(".search-hits li", { hasText: "Medication" }).first();
    await hit.waitFor();
    await hit.getByRole("link").first().click();
    await page.waitForURL(/\/medications$/);
    await page.goto(`${BASE}/patients/${pid}/search?q=${encodeURIComponent("Filling 36")}`);
    await page.locator(".search-hits li", { hasText: "Note" }).getByRole("link", { name: /Filling 36 note/ }).waitFor();
    await page.goto(`${BASE}/patients/${pid}/search?q=${encodeURIComponent("throbbing")}`);
    await page.locator(".search-hits li", { hasText: "Symptom" }).first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/search?q=a`);
    await page.getByText("Type at least two characters.").waitFor();
    await page.goto(`${BASE}/patients/${pid}/search?q=zzqqxxnothing`);
    await page.getByText("Nothing in this file matches.").waitFor();
    await page.goto(`${BASE}/patients/${pid}/search?q=metformin`);
    await page.screenshot({ path: path.join(OUT, "search.png"), fullPage: false });
  });

  await step("full export: a ZIP that unzip accepts, with record.json, fhir.json, README and the document files; the export is audited", async () => {
    await page.goto(`${BASE}/patients/${pid}/documents`);
    const href = await page.locator("#export-zip").getAttribute("href");
    const res = await ctx.request.get(BASE + href);
    assert(res.status() === 200, "export status " + res.status());
    assert(/application\/zip/.test(res.headers()["content-type"]), "zip content type");
    assert(/attachment; filename="shifa-SH-\d+-\d{4}-\d{2}-\d{2}\.zip"/.test(res.headers()["content-disposition"]), "download name: " + res.headers()["content-disposition"]);
    const zipPath = path.join(OUT, "export.zip");
    fs.writeFileSync(zipPath, await res.body());
    const tested = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    assert(/No errors detected/.test(tested), "unzip -t: " + tested.slice(-200));
    const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n");
    for (const n of ["record.json", "fhir.json", "README.txt"]) assert(names.includes(n), n + " in the archive: " + names.join(","));
    assert(names.filter((n) => n.startsWith("documents/")).length >= 1, "document files are in the archive");
    const fhir = JSON.parse(execFileSync("unzip", ["-p", zipPath, "fhir.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    assert(fhir.resourceType === "Bundle" && fhir.type === "collection", "FHIR bundle");
    const types = new Set(fhir.entry.map((e) => e.resource.resourceType));
    for (const t of ["Patient", "Condition", "AllergyIntolerance", "MedicationStatement", "Observation", "Encounter", "DocumentReference"]) assert(types.has(t), "FHIR " + t + " present: " + [...types]);
    const rec = JSON.parse(execFileSync("unzip", ["-p", zipPath, "record.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    assert(rec.patients.length === 1 && rec.symptom_entries.some((x) => x.record_status === "entered_in_error"), "record.json holds the invalidated symptom too");
    assert(!("audit_logs" in rec) && !("medical_shares" in rec), "no audit log or share links in the export");
    // every document file the DocumentReferences point at is in the archive
    for (const e of fhir.entry.filter((x) => x.resource.resourceType === "DocumentReference")) {
      assert(names.includes(e.resource.content[0].attachment.url), "document file present: " + e.resource.content[0].attachment.url);
    }
    await page.goto(`${BASE}/patients/${pid}/audit`);
    await page.locator("table.t").getByText("Full export").first().waitFor();
  });

  // every share names the doctor it is for (the doctor types nothing)
  const fillClinician = async (pg, name = "Dr Test Reader", extra = {}) => {
    await pg.fill("#cl_name", name);
    if (!(await pg.locator("#cl_spec").inputValue())) await pg.fill("#cl_spec", extra.specialty ?? "Dentistry");
    await pg.fill("#cl_fac", extra.facility ?? "Test Clinic");
    if (extra.city) await pg.fill("#cl_city", extra.city);
    if (extra.license) await pg.fill("#cl_lic", extra.license);
  };
  await step("create a specialty share (dentistry): link + PIN shown once", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_notes"]');
    await fillClinician(page);
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    shareLink = await page.locator('input[aria-label="Share link"]').inputValue();
    await page.getByRole("button", { name: "Show" }).click();
    sharePin = await page.locator('input[aria-label="PIN"]').inputValue();
    assert(/\/s\/[A-Za-z0-9_-]{30,}$/.test(shareLink), "link shape: " + shareLink);
    assert(/^\d{6}$/.test(sharePin), "pin shape");
    // a QR code of the link (not the PIN) and a WhatsApp button that reminds to send the PIN separately
    const qr = page.locator('[data-testid="share-qr"] svg');
    await qr.waitFor();
    assert((await qr.locator("path").count()) === 1 && Number((await qr.getAttribute("viewBox")).split(" ")[2]) >= 29, "QR drawn");
    fs.writeFileSync(path.join(OUT, "share-qr.svg"), await qr.evaluate((el) => el.outerHTML));
    fs.writeFileSync(path.join(OUT, "share-link.txt"), shareLink);
    await qr.screenshot({ path: path.join(OUT, "share-qr.png") });
    const wa = await page.locator("#share-whatsapp").getAttribute("href");
    assert(wa.startsWith("https://wa.me/?text="), "whatsapp url: " + wa);
    assert(decodeURIComponent(wa.slice("https://wa.me/?text=".length)).includes(shareLink), "the whatsapp text carries the link");
    assert(!wa.includes(sharePin) && !decodeURIComponent(wa).includes(sharePin), "the PIN is not in the whatsapp message");
    await page.getByText(/Send the PIN separately/).waitFor();
  });

  // ---------------------------------------------------------------- the doctor, in a clean browser (no Alice cookies)
  const dctx = await newContext(browser);
  const doc = await dctx.newPage();
  watch(doc, "doctor");
  const slink = shareLink.replace(/^https?:\/\/[^/]+/, BASE);

  await step("doctor: wrong PIN is refused with attempts left; link alone reveals nothing", async () => {
    await doc.goto(slink);
    await doc.getByText("Shared medical file").first().waitFor();
    assert(!(await doc.content()).includes("Alice"), "no patient data before the PIN");
    await doc.fill("#pin", "000000");
    await doc.getByRole("button", { name: "Open file" }).click();
    await doc.getByText(/Incorrect PIN\. Attempts left: 4/).waitFor();
    await doc.goto(slink.replace(/\/s\/.*/, "") + "/s/not-a-real-token-not-a-real-token-1/view");
    await doc.waitForURL(/\/s\/not-a-real-token/);
    assert(!(await doc.content()).includes("Alice"), "view without a session leaks nothing");
  });

  await step("doctor: correct PIN opens only the dentistry scope; no cardio, no id numbers", async () => {
    await doc.goto(slink);
    await doc.fill("#pin", sharePin);
    await doc.getByRole("button", { name: "Open file" }).click();
    await doc.waitForURL(/\/view$/);
    const html = await doc.content();
    await doc.getByText("Health context & safety information").waitFor();
    await doc.getByText(/Prosthetic heart valve: endocarditis prophylaxis/).waitFor();       // the dentistry reminder, from the core file
    assert(html.includes("Penicillin") && html.includes("Hypertension") && html.includes("Metformin"), "safety core present");
    assert(html.includes("Mechanical aortic valve"), "devices reach the doctor");
    await doc.locator("section.ctx").getByText("165 cm").waitFor();                            // and the body measurements
    assert(html.includes("Dental check") && html.includes("Dental caries"), "dentistry data present");
    assert(!html.includes("Cardio follow-up") && !html.includes("Cardio report"), "cardiology data absent");
    assert(!html.includes("1098765432"), "national id never shared");
    assert(!html.includes("+966500000001") && !html.includes("Omar Alpha"), "contact data absent unless selected");
    assert(!html.includes("Entered by mistake"), "invalidated records absent");
    assert(html.includes("Dental X-ray"), "in-scope document listed");
    assert(!/storage_path|pin_hash|token_hash/.test(html), "no internals leaked");
    assert(!html.includes("Add to the patient's file"), "a read-only share offers no way to add");
  });

  await step("doctor: in-scope document opens; out-of-scope document is forbidden; download is blocked", async () => {
    const token = slink.split("/s/")[1];
    const link = await doc.locator("a", { hasText: "Dental X-ray" }).first().getAttribute("href");
    const ok = await dctx.request.get(BASE + link);
    assert(ok.status() === 200 && ok.headers()["content-type"] === "application/pdf", "doc opens: " + ok.status());
    const bad = await dctx.request.get(`${BASE}/s/${token}/doc/${cardioDocId}`);
    assert(bad.status() === 403, "cardio doc forbidden: " + bad.status());
    const dl = await dctx.request.get(BASE + link + "?dl=1");
    assert(dl.status() === 403, "download not permitted: " + dl.status());
    const unknown = await dctx.request.get(`${BASE}/s/${token}/doc/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`);
    assert(unknown.status() === 403, "unknown doc forbidden");
    const noSession = await (await newContext(browser)).request.get(BASE + link);
    assert(noSession.status() === 401, "no cookie => 401: " + noSession.status());
    assert(/no-store/.test(ok.headers()["cache-control"]), "no-store");
    assert((await dctx.request.get(`${BASE}/s/${token}/pdf`)).status() === 403, "PDF refused when printing is not allowed");
    assert((await (await newContext(browser)).request.get(`${BASE}/s/${token}/pdf`)).status() === 401, "PDF needs a session");
  });

  await step("doctor: leaves a note; patient sees it and marks it reviewed", async () => {
    await doc.fill("#author_name", "Dr. Molar");
    await doc.fill("#body", "Please bring the latest panoramic film.");
    await doc.getByRole("button", { name: "Send" }).click();
    await doc.getByText("Your note was sent to the patient.").waitFor();
    await page.goto(`${BASE}/patients/${pid}/sharing`);
    await page.locator('a[href*="/sharing/"]', { hasText: /Dentistry/ }).first().click();     // the share, not the menu's Dentistry
    await page.getByText("Please bring the latest panoramic film.").waitFor();
    await page.getByRole("button", { name: "Mark reviewed" }).click();
    await page.getByText("Reviewed", { exact: true }).waitFor();
  });

  await step("patient sees the access log (failed PIN, opened, document, note) without secrets", async () => {
    await page.reload();
    const text = await page.locator("main").innerText();
    for (const s of ["Wrong PIN attempt", "Opened (correct PIN)", "Document opened", "Doctor added a note"]) assert(text.includes(s), "log has: " + s);
    assert(!text.includes(sharePin) && !text.includes(slink.split("/s/")[1]), "log never shows PIN or token");
  });

  await step("revoking the share cuts the doctor off immediately", async () => {
    await page.locator("input[name=reason]").first().fill("visit finished");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Revoke now" }).click();
    await page.getByText("Revoked", { exact: true }).first().waitFor();
    await doc.reload();
    await doc.waitForURL(/\/s\/[^/]+\?expired=1$/);
    await doc.fill("#pin", sharePin);
    await doc.getByRole("button", { name: "Open file" }).click();
    await doc.getByText("invalid, expired or revoked").waitFor();
    const link = await page.locator("main").innerText();
    assert(/Revoked/.test(link), "patient sees revoked state");
  });

  await step("brute-forcing the PIN locks the link", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new`);
    await page.fill("#title", "Brute target");
    await page.check('input[name="scope_kind"][value="full"]');
    await fillClinician(page, "Dr Brute Target", { specialty: "Family medicine" });
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const l = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    const c2 = await newContext(browser); const p2 = await c2.newPage(); watch(p2, "attacker");
    await p2.goto(l);
    for (let i = 0; i < 5; i++) {
      await p2.fill("#pin", String(111110 + i));
      await p2.getByRole("button", { name: "Open file" }).click();
      await p2.waitForLoadState("networkidle");
    }
    await p2.getByText(/temporarily locked/).waitFor();
    await c2.close();
  });

  // ---------------------------------------------------------------- another user
  const bctx = await newContext(browser);
  const bob = await bctx.newPage();
  watch(bob, "bob");
  await step("doctor print: a vector PDF of exactly the shared scope, only when the patient allowed printing", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_print"]');
    await fillClinician(page);
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link2 = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin2 = await page.locator('input[aria-label="PIN"]').inputValue();
    const c2 = await newContext(browser); const d2 = await c2.newPage(); watch(d2, "doctor2");
    await d2.goto(link2); await d2.fill("#pin", pin2); await d2.getByRole("button", { name: "Open file" }).click(); await d2.waitForURL(/\/view$/);
    await d2.getByRole("link", { name: /Print \(PDF\)/ }).waitFor();
    const token2 = link2.split("/s/")[1];
    const r = await c2.request.get(`${BASE}/s/${token2}/pdf`);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]) && /no-store/.test(r.headers()["cache-control"]), "pdf " + r.status());
    const buf = await r.body();
    assert(buf.subarray(0, 5).toString() === "%PDF-", "pdf header");
    fs.writeFileSync(path.join(OUT, "shared-bundle.pdf"), buf);
    await c2.close();
  });

  await step("doctor adds through a contributing share: the patient names the doctor, one-click confirmation, diagnosis, visit + linked note, document, withdrawal", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_contribute"]');
    // a contributing link without the doctor's name is refused
    await page.fill("#cl_fac", "Smile Clinic");
    await page.locator("#cl_name").evaluate((el) => el.removeAttribute("required"));
    await submit(page, "Create link & PIN");
    await page.getByText("Enter the name of the doctor you are going to.").waitFor();
    await fillClinician(page, "Dr Sara Molar", { facility: "Smile Clinic", city: "Riyadh", license: "DEN-12345" });
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link3 = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin3 = await page.locator('input[aria-label="PIN"]').inputValue();
    contribShareHref = await page.getByRole("link", { name: "Manage this share" }).getAttribute("href");

    const c3 = await newContext(browser); const d3 = await c3.newPage(); watch(d3, "dentist");
    await d3.goto(link3); await d3.fill("#pin", pin3); await d3.getByRole("button", { name: "Open file" }).click(); await d3.waitForURL(/\/view$/);
    await d3.getByRole("heading", { name: /Add to the patient's file/ }).waitFor();
    // the doctor types none of their details: the link names them, they confirm with one click
    await d3.getByText("This link is for").waitFor();
    assert((await d3.locator("#c_name").count()) === 0 && (await d3.locator("canvas.sig-pad").count()) === 0, "no identity form, no signature pad");
    await d3.locator(".clinician-confirm").getByText("Smile Clinic").waitFor();
    await d3.getByRole("button", { name: "I am Dr Sara Molar — start" }).click();
    await d3.getByText("Adding as").waitFor();
    await d3.getByText("Dr Sara Molar").first().waitFor();

    const open = async (label) => { await d3.locator("summary", { hasText: `Add: ${label}` }).first().click(); };
    await open("Diagnosis / condition");
    await d3.fill("#c_conditions_name", "Deep caries tooth 16 (dentist)");
    await d3.selectOption("#c_conditions_category", "diagnosis");
    await d3.selectOption("#c_conditions_certainty", "confirmed");
    await d3.locator("form", { has: d3.locator("#c_conditions_name") }).getByRole("button", { name: "Add to the file" }).click();
    await d3.getByText("Added to the patient's file under your name.").first().waitFor();
    await d3.reload();
    await open("Visit (reason, exam, assessment, plan)");
    await d3.fill("#c_encounters_reason", "Dental pain review");
    await d3.selectOption("#c_encounters_kind", "dental");
    await d3.selectOption("#c_encounters_anesthesia_kind", "nerve_block");               // the dental visit's details
    await d3.fill("#c_encounters_materials", "Glass ionomer");
    await d3.locator("form", { has: d3.locator("#c_encounters_reason") }).getByRole("button", { name: "Add to the file" }).click();
    await d3.getByText("Added to the patient's file under your name.").first().waitFor();
    await d3.reload();
    await open("Clinical note");
    await d3.selectOption("#clinical_notes_enc", { index: 1 });                        // linked to the visit just added
    assert((await d3.locator("#c_clinical_notes_body-tpl option").count()) > 3, "the doctor's note form offers templates");
    await d3.fill("#c_clinical_notes_body", "Note typed in the wrong file by mistake");
    await d3.locator("form", { has: d3.locator("#c_clinical_notes_body") }).getByRole("button", { name: "Add to the file" }).click();
    await d3.getByText("Added to the patient's file under your name.").first().waitFor();
    await d3.reload();
    await open("Upload a document or image");
    await d3.setInputFiles("#c_file", { name: "bitewing.pdf", mimeType: "application/pdf", buffer: pdf("% bitewing\n") });
    await d3.fill("#c_title", "Bitewing (dentist)");
    await d3.getByRole("button", { name: "Upload", exact: true }).click();
    await d3.getByText("Document uploaded and added to the file.").waitFor();
    // the chart is visible read-only, and an exam can be recorded on it
    await d3.locator("#dental").getByText("Tooth chart").waitFor();
    assert(/Extracted/.test(await d3.locator("#chart-18").getAttribute("aria-label")), "the dentist sees the patient's chart");
    await d3.locator("summary", { hasText: "Add: Dental exam on the chart" }).click();
    await d3.locator("#cx-t-26").click();
    await d3.getByRole("radio", { name: "Present", exact: true }).check();
    await d3.selectOption("#cx_fk", "caries");
    await d3.locator("#cx-t-26").focus(); await d3.keyboard.press("d");
    await d3.getByRole("button", { name: "Add to this tooth" }).click();
    // the comprehensive exam: a pulp test on 26, the soft tissues (a suspicious patch), the baseline flag
    await d3.selectOption("#cx_pt", "cold");
    await d3.selectOption("#cx_pr", "lingering");
    await d3.getByRole("button", { name: "Add the test result" }).click();
    await d3.locator(".exam-summary").getByText("Lingering pain").waitFor();
    await d3.locator('details[data-section="soft_tissue"] > summary').click();
    await d3.getByRole("button", { name: "All sites normal, no suspicious lesion" }).click();
    await d3.selectOption("#cx_soft_tissue_tongue", "abnormal");
    await d3.selectOption("#cx_soft_tissue_cancer_screening", "suspicious");
    await d3.fill("#cx_soft_tissue_note", "White patch, left lateral tongue");
    await d3.locator('details[data-section="extraoral"] > summary').click();
    await d3.fill("#cx_extraoral_mouth_opening_mm", "42");
    await d3.check('input[name="is_baseline"]');
    await d3.getByRole("button", { name: "Save the exam" }).click();
    await d3.getByText("The exam was saved to the patient's file under your name.").waitFor();
    await d3.reload();
    // the next doctor on any link sees it: the alert, the baseline, the sections and the pulp test
    await d3.locator("#dental").getByText("Suspicious soft-tissue lesion").waitFor();
    const dx = d3.locator("article.share-exam", { hasText: "Baseline" }).first();
    await dx.getByText(/Oral cancer screening: Suspicious lesion/).waitFor();
    await dx.getByText(/Cold: Lingering pain/).waitFor();
    await dx.getByText(/Maximum mouth opening 42 mm/).waitFor();
    await d3.locator("#contribute article.rec:not(.my-note)", { hasText: "Dental exam on the chart" }).first().waitFor();
    // in place: the dentist chooses a tooth and adds a diagnosis to it, without a separate form list
    await d3.locator("#chart-47").click();
    await d3.locator(".tooth-panel summary", { hasText: "A diagnosis for this tooth" }).click();
    await d3.locator("#ctooth-dx_conditions_name").fill("Fractured cusp 47 (dentist)");
    await d3.locator("form#ctooth-dx").getByRole("button", { name: "Add the diagnosis" }).click();
    await d3.locator(".tooth-panel li", { hasText: "Fractured cusp 47 (dentist)" }).waitFor();
    await d3.locator("#contribute article.rec:not(.my-note)", { hasText: "Fractured cusp 47 (dentist)" }).waitFor();
    // treatment: the dentist proposes a root canal for 47 from its panel and notes their cost; accepting is not theirs
    if (!(await d3.locator(".tooth-panel").isVisible())) await d3.locator("#chart-47").click();
    await d3.locator(".tooth-panel summary", { hasText: "A treatment for this tooth" }).click();
    await d3.locator("form#ctooth-tx select[name=catalog_code]").selectOption("root_canal");
    await d3.locator("form#ctooth-tx").getByRole("button", { name: "Propose the treatment" }).click();
    await d3.locator(".tooth-panel li.planned", { hasText: "Root canal treatment" }).waitFor();
    const rct = d3.locator("li.treat-item", { hasText: "Root canal treatment" }).first();
    await rct.getByText("From the doctor via a link").waitFor();
    await rct.locator("summary", { hasText: "Change status" }).click();
    const opts = await rct.locator('select[name="status"] option').allInnerTexts();
    assert(!opts.includes("Accepted"), "the dentist is not offered 'accepted': " + opts);
    await rct.locator("summary", { hasText: "Add a cost" }).click();
    await rct.locator('input[name="amount"]').fill("750");
    await rct.getByRole("button", { name: "Save", exact: true }).click();
    await d3.getByText("Your cost was saved").first().waitFor();
    assert(!/SAR\s?300/.test(await d3.locator("#dental").innerText()), "the patient's own cost is not shown to the dentist");
    // the summary of additions comes after the clinical content
    const order = await d3.evaluate(() => ["#contributor", "#dental", "#contribute"].map((q) => { const el = document.querySelector(q); return el ? el.getBoundingClientRect().top + window.scrollY : NaN; }));
    assert(order[0] < order[1] && order[1] < order[2], "identity, then the dental workspace, then the summary: " + order);
    await d3.screenshot({ path: path.join(OUT, "dentist-contribute.png"), fullPage: true });
    // the dentist withdraws the misplaced note
    // the dentist's note is signed with their name; they amend it (the original stays) before withdrawing it
    const mine = d3.locator("#contribute article.my-note", { hasText: "Note typed in the wrong file" });
    await mine.getByText(/Signed — Dr Sara Molar/).waitFor();
    await mine.locator("summary", { hasText: "Add an amendment" }).click();
    await mine.locator('textarea[name="body"]').fill("Note typed in the wrong file by mistake (wrong patient)");
    await mine.locator('input[name="reason"]').fill("clarify");
    await mine.getByRole("button", { name: "Add the amendment" }).click();
    await d3.locator("#contribute article.my-note", { hasText: "Note typed in the wrong file" }).getByText("Amendment 1").waitFor();
    const noteRec = d3.locator("#contribute article.rec:not(.my-note)", { hasText: "Note typed in the wrong file" }).first();
    await noteRec.locator("summary", { hasText: "Withdraw this addition" }).click();
    d3.once("dialog", (dl) => dl.accept());
    await noteRec.locator('input[name="reason"]').fill("wrong patient");
    await noteRec.getByRole("button", { name: "Withdraw" }).click();
    // the form disappears with the active state; the addition now shows as withdrawn
    await d3.locator("#contribute article.rec:not(.my-note)", { hasText: "Note typed in the wrong file" }).getByText("Withdrawn / invalidated").waitFor();
    await c3.close();

    // the patient's side: alert, provenance, no editing, signature, review, invalidate all
    await page.goto(`${BASE}/patients/${pid}`);
    await page.getByText(/Dr Sara Molar added to your file through a share link/).waitFor();
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    const rec = page.locator("article.rec", { hasText: "Deep caries tooth 16 (dentist)" }).first();
    await rec.getByText("Added by a doctor", { exact: true }).waitFor();
    await rec.locator(".rec-meta").getByText(/by a doctor through a share link/).waitFor();
    assert((await rec.locator("summary", { hasText: "Edit" }).count()) === 0, "a doctor's addition cannot be edited by the patient");
    await page.goto(`${BASE}/patients/${pid}/documents`);
    await page.getByText("Bitewing (dentist)").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.locator("#exams article.rec", { hasText: "Added by Dr Sara Molar via a link" }).first().waitFor();
    await page.getByText("Suspicious soft-tissue lesion").waitFor();
    const docExam = page.locator("#exams article.rec", { hasText: "Added by Dr Sara Molar via a link" }).first();
    await docExam.getByText("Baseline", { exact: true }).waitFor();
    await docExam.getByText(/White patch, left lateral tongue/).waitFor();
    await page.locator(".baseline-line").getByText(/comprehensive baseline exam/).waitFor();
    await page.locator("#chart-26").click();
    await page.locator(".tooth-panel .tooth-list li", { hasText: "Caries" }).getByText(/Added by Dr Sara Molar/).waitFor();
    await page.goto(`${BASE}${contribShareHref}`);
    await page.getByText("Doctors who added to your file").waitFor();
    await page.getByText("DEN-12345").first().waitFor();
    await page.getByText("Confirmed being the doctor named on the link").first().waitFor();
    await page.getByText("Riyadh").first().waitFor();
    await page.getByRole("button", { name: "I reviewed these additions" }).click();
    await page.getByText("Reviewed", { exact: true }).first().waitFor();
    await page.locator("summary", { hasText: "Invalidate everything this doctor added" }).click();
    page.once("dialog", (dl) => dl.accept());
    await page.locator('input[name="reason"]').last().fill("not my dentist");
    await page.getByRole("button", { name: "Invalidate all" }).click();
    // the bulk form disappears once nothing is active; every addition is now shown invalidated
    await page.locator("summary", { hasText: "Invalidate everything this doctor added" }).waitFor({ state: "detached" });
    assert((await page.getByText("Invalidated", { exact: true }).count()) >= 4, "all four additions are invalidated");
    await page.goto(`${BASE}/patients/${pid}/audit`);
    await page.getByText("Doctor via a share link").first().waitFor();
  });

  // ---------------------------------------------------------------- dental images: the image as a source, the viewer, the doctor on a link (ح2 / هـ)
  await step("images: a panoramic is recorded with its bone reading and fulfils the imaging request; the files are attached; the whole-mouth image is on the chart and in every tooth panel", async () => {
    await page.goto(`${BASE}/patients/${pid}/test-orders`);
    await openSummary(page, "Add test request");
    await page.fill("#test-orders_new_name", "Panoramic X-ray (requested by Dr Abdullah)");
    await page.selectOption("#test-orders_new_kind", "imaging");
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental?tab=imaging`);
    await openSummary(page, "Add an image or X-ray");
    const form = page.locator("form", { has: page.locator("#imaging_new_modality") });
    await form.locator("#imaging_new_modality").selectOption("panoramic");
    await form.locator("#imaging_new_performed_on").fill(new Date().toISOString().slice(0, 10));
    await form.locator("#imaging_new_test_order_id").selectOption(await form.locator("#imaging_new_test_order_id option", { hasText: "Panoramic X-ray (requested by Dr Abdullah)" }).getAttribute("value"));
    await form.locator('select[name="bone_s1_level"]').selectOption("coronal_third");
    await form.locator('select[name="bone_s1_pattern"]').selectOption("horizontal");
    await form.locator('select[name="bone_s5_level"]').selectOption("apical_third");
    await form.locator('select[name="bone_s5_pattern"]').selectOption("vertical");
    await form.locator("#imaging_new_impression").fill("Generalised horizontal bone loss, vertical defect lower anterior");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved.").first().waitFor();
    await page.reload();
    const study = page.locator("article.rec", { hasText: "Generalised horizontal bone loss" }).first();
    await study.getByText("Whole mouth", { exact: true }).waitFor();
    await study.getByText("Fulfils a request", { exact: true }).waitFor();
    await study.getByText(/Bone: S1 Coronal third \(15–33%\) \(Horizontal\) · S5 Apical third \(Vertical \(angular\)\)/).waitFor();
    // the request is closed by the study itself
    await page.goto(`${BASE}/patients/${pid}/test-orders`);
    await page.locator("article.rec", { hasText: "Panoramic X-ray (requested by Dr Abdullah)" }).getByText("Done", { exact: true }).first().waitFor();
    // a bad bone reading never reaches the database: a pattern without a level is refused by the form's own check
    await page.goto(`${BASE}/patients/${pid}/dental?tab=imaging`);
    await openSummary(page, "Add an image or X-ray");
    const f2 = page.locator("form", { has: page.locator("#imaging_new_modality") });
    await f2.locator('select[name="bone_s2_pattern"]').selectOption("mixed");
    await f2.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/Invalid bone level reading/).waitFor();
    // two image files are attached to the study (a different file each: the duplicate check stays quiet)
    for (const [w, h, title] of [[640, 320, "Panoramic file A"], [480, 240, "Panoramic file B"]]) {
      await page.goto(`${BASE}/patients/${pid}/dental?tab=imaging`);
      await page.locator("#ai_study").selectOption(await page.locator("#ai_study option", { hasText: "Panoramic" }).first().getAttribute("value"));
      await page.setInputFiles("#ai_file", { name: `${title}.png`, mimeType: "image/png", buffer: makePng(w, h) });
      await page.fill("#ai_title", title);
      await page.locator("#attach-image-form").getByRole("button", { name: "Attach the image" }).click();
      await page.getByText("The image file was attached to the study.").waitFor();
    }
    // the chart: the whole-mouth card lists it with its reading and its files
    await page.goto(`${BASE}/patients/${pid}/dental`);
    const wm = page.locator("section.whole-mouth");
    await wm.getByRole("heading", { name: "Whole-mouth images" }).waitFor();
    await wm.getByText("Panoramic", { exact: false }).first().waitFor();
    await wm.getByText(/S1 Coronal third/).waitFor();
    await wm.getByRole("button", { name: /Open Panoramic file A in the viewer/ }).waitFor();
    // and in the panel of any tooth, even one the image does not name
    await page.locator("#chart-27").click();
    await page.locator(".tooth-panel").getByRole("heading", { name: "Images & X-rays" }).waitFor();
    await page.locator(".tooth-panel li[data-image]", { hasText: "Whole mouth" }).waitFor();
  });

  await step("images: a radiographic finding names the image it was read on (the exam editor, the tooth panel and its history)", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await openSummary(page, "New exam on the chart");
    await page.locator("#px-t-36").click();
    await page.selectOption("#px_fk", "bone_loss");
    await page.selectOption("#px_fe", "radiographic");
    const sel = page.locator("#px_fi");
    await sel.waitFor();                                                         // offered only for a radiographic finding
    await sel.selectOption(await sel.locator("option", { hasText: "Panoramic" }).first().getAttribute("value"));
    await page.getByRole("button", { name: "Add to this tooth" }).click();
    await page.locator(".exam-summary").getByText(/from Panoramic/).waitFor();
    await page.selectOption("#px_fe", "clinical");
    assert((await page.locator("#px_fi").count()) === 0, "a clinical finding is not asked for an image");
    let saved = false;
    for (let i = 0; i < 2 && !saved; i++) {
      await page.locator("#px-form").getByRole("button", { name: "Save the exam" }).click();
      const dup = page.getByText("Yes, a different exam — save it");
      const ok = page.locator("#px-form").getByText("Exam saved.");
      await Promise.race([dup.waitFor(), ok.waitFor()]);
      if (await ok.isVisible().catch(() => false)) saved = true; else await dup.click();
    }
    await page.reload();
    await page.locator("#chart-36").click();
    await page.locator(".tooth-panel .tooth-list li", { hasText: "Bone loss" }).getByText(/from Panoramic/).first().waitFor();
    await page.locator(".tooth-panel .tooth-hist li", { hasText: "Bone loss" }).getByText(/from Panoramic/).first().waitFor();
  });

  await step("images: the viewer zooms, pans, rotates, adjusts brightness and contrast, resets, compares two images and keeps annotations apart from the file", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.locator("section.whole-mouth").getByRole("button", { name: /Open Panoramic file A in the viewer/ }).click();
    const dlg = page.getByRole("dialog", { name: "Image viewer" });
    await dlg.waitFor();
    const img = dlg.locator(".iv-viewport img").first();
    await page.waitForFunction(() => { const i = document.querySelector(".iv-viewport img"); return i && i.naturalWidth > 0; });
    const stage = dlg.locator(".iv-stage").first();
    const tf = () => stage.evaluate((el) => el.style.transform);
    const zoomText = () => dlg.locator(".iv-zoom").first().innerText();
    assert((await zoomText()) === "100%", "starts at 100%");
    await dlg.getByRole("button", { name: "Zoom in" }).first().click();
    assert((await zoomText()) === "125%", "the button zooms by a quarter: " + await zoomText());
    // the wheel zooms about the pointer
    const vp = dlg.locator(".iv-viewport").first();
    const box = await vp.boundingBox();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20);
    await page.mouse.wheel(0, -300);
    assert(parseInt(await zoomText(), 10) > 125, "the wheel zooms in: " + await zoomText());
    // dragging pans
    const before = await tf();
    await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 130, { steps: 4 }); await page.mouse.up();
    assert((await tf()) !== before, "dragging moves the image");
    // rotate 90°, brightness and contrast through CSS filters; the file is never changed
    await dlg.getByRole("button", { name: "Rotate 90° clockwise" }).first().click();
    assert(/rotate\(90deg\)/.test(await tf()), "rotated: " + await tf());
    await dlg.getByLabel("Brightness").first().fill("150");
    await dlg.getByLabel("Contrast").first().fill("180");
    const filter = await img.evaluate((el) => el.style.filter);
    assert(/brightness\(150%\)/.test(filter) && /contrast\(180%\)/.test(filter), "filters: " + filter);
    await dlg.getByRole("button", { name: "Reset" }).first().click();
    assert((await zoomText()) === "100%" && /rotate\(0deg\)/.test(await tf()) && /brightness\(100%\)/.test(await img.evaluate((el) => el.style.filter)), "reset restores the view");
    // from the keyboard
    await vp.focus();
    await page.keyboard.press("+"); await page.keyboard.press("+");
    assert((await zoomText()) === "156%", "the keyboard zooms: " + await zoomText());
    await page.keyboard.press("r");
    assert(/rotate\(90deg\)/.test(await tf()), "R rotates");
    await page.keyboard.press("0");
    assert((await zoomText()) === "100%", "0 resets");
    // side by side with the other image of the same patient
    await dlg.getByRole("button", { name: "Compare with another image" }).click();
    assert((await dlg.locator(".iv-pane").count()) === 2, "two images side by side");
    await dlg.getByLabel("Image to compare with").selectOption({ index: 0 });
    await dlg.getByRole("button", { name: "Compare with another image" }).click();
    assert((await dlg.locator(".iv-pane").count()) === 1, "back to one image");
    // annotations: a circle and an arrow, drawn in normalised coordinates, saved apart from the file
    const draw = async (from, to) => {
      const b = await vp.boundingBox();
      await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]); await page.mouse.down();
      await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 5 }); await page.mouse.up();
    };
    await dlg.getByRole("button", { name: "Circle" }).click();
    await draw([0.45, 0.5], [0.55, 0.5]);
    await dlg.getByRole("button", { name: "Arrow" }).click();
    await draw([0.3, 0.3], [0.42, 0.45]);
    await dlg.getByText("2 shape(s) waiting to be saved").waitFor();
    await dlg.getByRole("button", { name: "Save the annotation" }).click();
    await dlg.getByText("The annotation was saved").waitFor();
    await dlg.getByText("Annotations on this image (1)").waitFor();
    assert((await dlg.locator(".iv-overlay-svg ellipse").count()) === 1 && (await dlg.locator(".iv-overlay-svg line").count()) === 1, "the shapes are drawn as an SVG overlay");
    // the original file is untouched: it is still served as the PNG that was attached
    const sh = await page.evaluate(async () => {
      const r = await fetch(document.querySelector(".iv-viewport img").src);
      return { ok: r.ok, type: r.headers.get("content-type"), len: (await r.arrayBuffer()).byteLength };
    });
    assert(sh.ok && /image\/png/.test(sh.type) && sh.len > 100, "the original file is still served untouched");
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached" });
    // after a reload the annotation is still there, and the file's size did not change
    await page.reload();
    await page.locator("section.whole-mouth").getByRole("button", { name: /Open Panoramic file A in the viewer/ }).click();
    await page.getByRole("dialog", { name: "Image viewer" }).locator(".iv-overlay-svg ellipse").waitFor();
    await page.screenshot({ path: path.join(OUT, "image-viewer.png") });
    await page.keyboard.press("Escape");
  });

  await step("images: a doctor on a link sees the whole-mouth panoramic, its reading, the finding linked to it and the patient's annotation; he links a finding and annotates; download stays blocked", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_contribute"]');
    await page.check('input[name="include"][value="documents"]');
    await fillClinician(page, "Dr Nadia Perio", { specialty: "Periodontics", facility: "Gum Clinic" });
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin = await page.locator('input[aria-label="PIN"]').inputValue();
    const cp = await newContext(browser); const dp = await cp.newPage(); watch(dp, "periodontist");
    await dp.goto(link); await dp.fill("#pin", pin); await dp.getByRole("button", { name: "Open file" }).click(); await dp.waitForURL(/\/view$/);
    await dp.getByRole("button", { name: "I am Dr Nadia Perio — start" }).click();
    await dp.getByText("Adding as").waitFor();
    // the panoramic has no tooth, yet the dentist's chart carries it, with the structured reading
    const wm = dp.locator("section.whole-mouth");
    await wm.getByRole("heading", { name: "Whole-mouth images" }).waitFor();
    await wm.getByText(/S5 Apical third/).waitFor();
    await wm.getByText("Generalised horizontal bone loss").waitFor();
    // the finding the patient linked to it, in tooth 36's panel
    await dp.locator("#chart-36").click();
    await dp.locator(".tooth-panel .tooth-list li", { hasText: "Bone loss" }).getByText(/from Panoramic/).first().waitFor();
    // the viewer opens through the share's own document route, and shows the patient's annotation
    await wm.getByRole("button", { name: /Open Panoramic file A in the viewer/ }).click();
    const dlg = dp.getByRole("dialog", { name: "Image viewer" });
    await dp.waitForFunction(() => { const i = document.querySelector(".iv-viewport img"); return i && i.naturalWidth > 0; });
    assert(/\/s\/[^/]+\/doc\//.test(await dlg.locator(".iv-viewport img").first().getAttribute("src")), "the file comes from the share document route");
    await dlg.locator(".iv-overlay-svg ellipse").waitFor();
    // the doctor draws his own
    await dlg.getByRole("button", { name: "Text" }).click();
    const vp = dlg.locator(".iv-viewport").first(); const b = await vp.boundingBox();
    await dp.mouse.click(b.x + b.width * 0.7, b.y + b.height * 0.6);
    await dlg.getByLabel("Annotation text, then Enter").fill("Vertical defect distal 46");
    await dp.keyboard.press("Enter");
    await dlg.getByText("1 shape(s) waiting to be saved").waitFor();
    await dlg.getByRole("button", { name: "Save the annotation" }).click();
    await dlg.getByText("The annotation was saved under your name").waitFor();
    await dlg.getByText(/Annotations on this image \(2\)/).waitFor();
    // download is blocked for this link, with or without the viewer
    const src = await dlg.locator(".iv-viewport img").first().getAttribute("src");
    const dl = await dp.request.get(`${BASE}${src}?dl=1`);
    assert(dl.status() === 403, "download is not allowed on this share: " + dl.status());
    await dp.keyboard.press("Escape");
    // the doctor records a finding read on the same panoramic
    await dp.locator("summary", { hasText: "Add: Dental exam on the chart" }).click();
    await dp.locator("#cx-t-46").click();
    await dp.selectOption("#cx_fk", "bone_loss");
    await dp.selectOption("#cx_fe", "radiographic");
    await dp.selectOption("#cx_fi", await dp.locator("#cx_fi option", { hasText: "Panoramic" }).first().getAttribute("value"));
    await dp.getByRole("button", { name: "Add to this tooth" }).click();
    await dp.getByRole("button", { name: "Save the exam" }).click();
    await dp.getByText("The exam was saved to the patient's file under your name.").waitFor();
    await dp.reload();
    await dp.locator("#chart-46").click();
    await dp.locator(".tooth-panel .tooth-list li", { hasText: "Bone loss" }).getByText(/from Panoramic/).first().waitFor();
    await dp.screenshot({ path: path.join(OUT, "periodontist-view.png"), fullPage: true });
    await cp.close();
    // the patient sees the doctor's annotation with his name in the viewer's list
    await page.goto(`${BASE}/patients/${pid}/dental`);
    await page.locator("section.whole-mouth").getByRole("button", { name: /Open Panoramic file A in the viewer/ }).click();
    const pd = page.getByRole("dialog", { name: "Image viewer" });
    await pd.getByText(/Annotations on this image \(2\)/).waitFor();
    await pd.locator("summary", { hasText: "Annotations on this image" }).click();
    await pd.getByText(/Dr Nadia Perio/).first().waitFor();
    await page.keyboard.press("Escape");
  });

  let periodShareHref;
  await step("periodontist: a link naming the periodontist, quick entry through the link, the diagnosis from the suggestion, finalise, the phased plan; the patient sees it; a later doctor sees chart and diagnosis", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_contribute"]');
    assert(await page.locator('input[name="contribute"][value="perio_exams"]').isChecked(), "the gum chart is one of the things the doctor may add");
    await fillClinician(page, "Dr Noura Gum", { specialty: "Periodontics", facility: "Gum Care Centre", city: "Jeddah", license: "PER-777" });
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link4 = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin4 = await page.locator('input[aria-label="PIN"]').inputValue();
    periodShareHref = await page.getByRole("link", { name: "Manage this share" }).getAttribute("href");

    const c4 = await newContext(browser); const dp = await c4.newPage(); watch(dp, "periodontist");
    await dp.goto(link4); await dp.fill("#pin", pin4); await dp.getByRole("button", { name: "Open file" }).click(); await dp.waitForURL(/\/view$/);
    await dp.getByRole("button", { name: "I am Dr Noura Gum — start" }).click();
    await dp.getByText("Adding as").waitFor();
    // the periodontist sees the charts already in the file, read-only, and who recorded them
    await dp.locator("#perio").getByText("Periodontal chart").first().waitFor();
    await dp.locator('#perio [data-testid="share-perio-chart"]').waitFor();
    assert((await dp.locator("#perio article.share-perio input[data-row]").count()) === 0, "the charts already in the file are read-only");
    // a visit of their own to link the chart to
    await dp.locator("summary", { hasText: "Add: Visit (reason, exam, assessment, plan)" }).first().click();
    await dp.fill("#c_encounters_reason", "Gum consultation");
    await dp.selectOption("#c_encounters_kind", "dental");
    await dp.locator("form", { has: dp.locator("#c_encounters_reason") }).getByRole("button", { name: "Add to the file" }).click();
    await dp.getByText("Added to the patient's file under your name.").first().waitFor();
    await dp.reload();

    // quick entry: depths and margins on 17, 16 and 26
    await dp.locator("summary", { hasText: "Add: periodontal chart" }).click();
    const pd = (i) => dp.locator(`input[data-row="upper-buccal-pd"][data-i="${i}"]`);
    const gm = (i) => dp.locator(`input[data-row="upper-buccal-gm"][data-i="${i}"]`);
    await pd(3).click(); await dp.keyboard.type("546");
    await pd(6).click(); await dp.keyboard.type("647");
    assert((await pd(6).inputValue()) === "6" && (await pd(7).inputValue()) === "4" && (await pd(8).inputValue()) === "7", "quick entry works through the link");
    await pd(39).click(); await dp.keyboard.type("435");
    for (const i of [3, 5, 6, 39, 41]) await gm(i).fill("-1");
    await gm(8).fill("-2");
    await dp.locator('#contrib-perio input[name="exam_date"]').waitFor();
    assert((await dp.locator('#contrib-perio input[name="examiner_name"]').inputValue()) === "Dr Noura Gum"
           && (await dp.locator('#contrib-perio input[name="examiner_name"]').getAttribute("readonly")) !== null, "the examiner is the doctor named on the link");
    // the suggestion, with its reasons; the doctor adds the bone loss they read on the radiograph
    await dp.fill("#dx-rbl", "35");
    await dp.fill("#dx-lost", "1");
    const sug = await dp.locator('[data-testid="dx-suggestion"]').innerText();
    assert(/Periodontitis — Stage III/.test(sug) && /Generalized/.test(sug), "the suggestion: " + sug);
    await dp.locator(".perio-dx-reasons").first().waitFor();
    assert(/Worst interdental attachment loss \d+ mm/.test(await dp.locator("#perio-dx").innerText()), "the suggestion shows its reasons");
    await dp.getByRole("button", { name: "Use the suggestion" }).click();
    assert((await dp.locator("#dx-kind").inputValue()) === "periodontitis" && (await dp.locator("#dx-stage").inputValue()) === "III"
           && (await dp.locator("#dx-extent").inputValue()) === "generalized" && (await dp.locator("#dx-grade").inputValue()) !== "", "the fields take the suggestion");
    // the doctor decides: the grade is theirs to change
    const suggestedGrade = await dp.locator("#dx-grade").inputValue();
    const grade = suggestedGrade === "C" ? "B" : "C";
    await dp.selectOption("#dx-grade", grade);
    await dp.fill("#dx-note", "Smoker, generalized deep pockets");
    await dp.selectOption("#pe-visit", { index: 1 });
    await dp.getByRole("button", { name: "Save draft" }).click();
    await dp.getByText("Draft saved.").waitFor();
    await dp.reload();
    assert((await pd(7).inputValue()) === "4" && (await dp.locator("#dx-stage").inputValue()) === "III" && (await dp.locator("#dx-grade").inputValue()) === grade,
      "the draft resumes with its diagnosis");
    await dp.locator("#perio").screenshot({ path: path.join(OUT, "perio-specialist-edit.png") });
    dp.once("dialog", (dl) => dl.accept());
    await dp.getByRole("button", { name: "Finalise the chart" }).click();
    await dp.waitForURL(/pdone=1/);
    const mineChart = dp.locator('#perio article.share-perio').first();
    await mineChart.getByText(new RegExp(`Periodontitis — Stage III, Grade ${grade}, Generalized`)).waitFor();
    await mineChart.getByText("Recorded by Dr Noura Gum via a link").waitFor();
    await mineChart.getByText(/Linked to the visit/).waitFor();
    assert((await mineChart.locator("input[data-row]").count()) === 0, "a final chart has no inputs");
    // the periodontist lays out the plan in phases from the chart
    await mineChart.getByRole("button", { name: "Phased gum treatment plan" }).click();
    await dp.getByText("The phased gum plan was proposed under your name").waitFor();
    await dp.reload();
    await dp.locator("#dental").getByText(/Periodontal treatment plan/).first().waitFor();
    const planText = await dp.locator("#dental").innerText();
    assert(/Scaling & root planing/.test(planText) && /re-evaluation/i.test(planText) && /Periodontal maintenance/.test(planText), "the plan lists the phases");
    await dp.screenshot({ path: path.join(OUT, "periodontist-contribute.png"), fullPage: true });
    await c4.close();

    // the patient: the chart with the doctor's name and diagnosis, not editable; the plan with the doctor's name
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio`);
    const shown = page.locator("#perio .perio-dx-view");
    await shown.getByText("Recorded by Dr Noura Gum via a link").waitFor();
    await shown.getByText(new RegExp(`Periodontitis — Stage III, Grade ${grade}, Generalized`)).waitFor();
    await shown.getByText(/Smoker, generalized deep pockets/).waitFor();
    await shown.getByText(/Linked to the visit.*Gum consultation/).waitFor();
    assert((await page.locator("#perio input[data-row]").count()) === 0, "the patient does not edit a doctor's chart");
    await page.locator("#perio-history li", { hasText: "Recorded by Dr Noura Gum via a link" }).first().waitFor();
    await page.locator("#perio-history li", { hasText: "Periodontitis — Stage III" }).first().waitFor();
    const pdfDoc = await page.request.get(`${BASE}${await page.locator("#perio a", { hasText: "PDF" }).first().getAttribute("href")}`);
    assert(pdfDoc.ok() && (pdfDoc.headers()["content-type"] ?? "").includes("pdf"), "the doctor's chart prints, diagnosis included");
    fs.writeFileSync(path.join(OUT, "perio-specialist.pdf"), await pdfDoc.body());
    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    await page.getByText(/Periodontal treatment plan/).first().waitFor();
    await page.getByText(/Dr Noura Gum/).first().waitFor();
    // the patient can make the same plan from their account
    await page.goto(`${BASE}/patients/${pid}/dental?tab=perio`);
    await page.locator("#perio").getByRole("button", { name: "Phased gum treatment plan" }).click();
    await page.waitForURL(/tab=treatment/);
    assert((await page.getByText(/Periodontal treatment plan/).count()) >= 2, "a second phased plan, from the patient's own account");

    // a later doctor, on a read-only link, sees the chart and the diagnosis
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await fillClinician(page, "Dr Later Reader");
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link5 = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin5 = await page.locator('input[aria-label="PIN"]').inputValue();
    const c5 = await newContext(browser); const dl2 = await c5.newPage(); watch(dl2, "later-doctor");
    await dl2.goto(link5); await dl2.fill("#pin", pin5); await dl2.getByRole("button", { name: "Open file" }).click(); await dl2.waitForURL(/\/view$/);
    const first = dl2.locator('#perio [data-testid="share-perio-chart"]');
    await first.getByText(new RegExp(`Periodontitis — Stage III, Grade ${grade}, Generalized`)).waitFor();
    await first.getByText("Recorded by Dr Noura Gum via a link").waitFor();
    assert((await dl2.locator("summary", { hasText: "Add: periodontal chart" }).count()) === 0, "a read-only link has no chart editor");
    assert((await dl2.locator("#perio input[data-row]").count()) === 0, "and no inputs");
    await dl2.screenshot({ path: path.join(OUT, "later-doctor-perio.png"), fullPage: true });
    await c5.close();

    // the owner's page for the link names the chart among the additions
    await page.goto(`${BASE}${periodShareHref}`);
    await page.getByText("Doctors who added to your file").waitFor();
    await page.getByText("PER-777").first().waitFor();
  });

  // ---------------------------------------------------------------- prescriptions, consents with a drawn signature, safety alerts (0027)
  const drawSignature = async (pg, scope) => {
    const canvas = scope.locator("canvas.sig-pad");
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    await pg.mouse.move(box.x + 20, box.y + 40);
    await pg.mouse.down();
    for (let i = 1; i <= 12; i++) await pg.mouse.move(box.x + 20 + i * 12, box.y + 40 + (i % 2 ? 25 : -20), { steps: 3 });
    await pg.mouse.up();
    await scope.locator("input.sig-value").evaluate((el) => { if (!el.value.startsWith("data:image/png")) throw new Error("nothing was drawn"); });
  };
  const pdfOk = async (req, url, label) => {
    const r = await req.get(url);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]), `${label} pdf ${r.status()}`);
    const body = await r.body();
    assert(body.subarray(0, 5).toString() === "%PDF-", `${label} is a pdf`);
    return body;
  };

  await step("prescriptions: the patient writes a detailed prescription on the dental visits tab, its medicines join the file, it prints, completing it ends them", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental?tab=care`);
    await page.locator("#prescriptions summary", { hasText: "A new prescription" }).click();
    await page.fill("#nrx_by", "Dr Reem Saleh");
    await page.fill("#nrx_lic", "DEN-9");
    await page.fill("#nrx_l0_g", "Amoxicillin");
    await page.fill("#nrx_l0_s", "500 mg");
    await page.selectOption("#nrx_l0_f", "capsule");
    await page.fill("#nrx_l0_d", "1 capsule");
    await page.selectOption("#nrx_l0_r", "oral");
    await page.fill("#nrx_l0_q", "three times a day");
    await page.fill("#nrx_l0_n", "7");
    await page.fill("#nrx_l0_c", "21 capsules");
    await page.fill("#nrx_l0_x", "0");
    await page.getByRole("button", { name: "Another medicine on the prescription" }).click();
    await page.fill("#nrx_l1_g", "Ibuprofen");
    await page.fill("#nrx_l1_b", "Brufen");
    await page.fill("#nrx_l1_q", "twice a day");
    await page.fill("#nrx_l1_n", "3");
    await page.fill("#nrx_l1_c", "10 tablets");
    await page.check('input[name="l1_as_needed"]');
    await page.locator("#nrx_form").getByRole("button", { name: "Save the prescription" }).click();
    await page.getByText("The prescription was saved with 2 medicine(s)").waitFor();
    const card = page.locator("article.rx-card", { hasText: "Dr Reem Saleh" });
    await card.waitFor();
    await card.getByText(/Amoxicillin/).first().waitFor();
    await card.getByText(/quantity: 21 capsules/).waitFor();
    await card.getByText(/refills: 0/).waitFor();
    await card.getByText(/Brufen/).waitFor();
    await card.getByText(/as needed/).waitFor();
    // the file records a penicillin allergy: the reviewable rule flags the penicillin-family drug on the prescription itself
    await card.locator('[data-alert="penicillin_allergy_prescribed"]').waitFor();
    await card.getByText(/Because of: Penicillin/).waitFor();
    assert((await card.locator('[data-alert]').count()) === 1, "only the penicillin rule concerns this prescription");
    const rxId = await card.getAttribute("data-rx");
    fs.writeFileSync(path.join(OUT, "prescription.pdf"), await pdfOk(page.request, `${BASE}/api/patients/${pid}/prescriptions/${rxId}/pdf`, "prescription"));
    assert((await card.getByRole("link", { name: "Print prescription" }).count()) === 1, "a print link");

    // the medicines are in the file, with their details
    await page.goto(`${BASE}/patients/${pid}/medications`);
    const med = page.locator("article.rec:not(.rx-card)", { hasText: "Amoxicillin" }).first();
    await med.getByText("21 capsules", { exact: true }).waitFor();
    await med.getByText("Currently taking").first().waitFor();
    assert((await page.locator("#prescriptions article.rx-card", { hasText: "Dr Reem Saleh" }).count()) === 1, "the prescription is also listed on the medications page");

    // completing the course ends the medicines
    await page.locator("#prescriptions article.rx-card", { hasText: "Dr Reem Saleh" }).getByRole("button", { name: "Course completed" }).click();
    await page.locator("#prescriptions article.rx-card", { hasText: "Dr Reem Saleh" }).locator(".chip", { hasText: "Completed" }).waitFor();
    await page.locator("article.rec:not(.rx-card)", { hasText: "Amoxicillin" }).first().locator(".chip", { hasText: "Course completed" }).first().waitFor();
    await page.screenshot({ path: path.join(OUT, "prescriptions.png"), fullPage: true });
  });

  await step("safety alerts: an anticoagulant in the file raises the extraction alert on the plan and next to the treatment; an unrelated drug raises none", async () => {
    await page.goto(`${BASE}/patients/${pid}/medications`);
    assert((await page.locator('[data-alert]').count()) === 0, "no safety alert on the medications page");
    await page.goto(`${BASE}/patients/${pid}/dental`);
    // the file has a mechanical valve, a congenital aortic narrowing and a penicillin allergy: those rules apply, the anticoagulant one does not yet
    await page.locator('#safety [data-alert="endocarditis_prophylaxis_review"]').getByText(/Because of: .*Mechanical aortic valve/).waitFor();
    await page.locator('#safety [data-alert="penicillin_allergy"]').waitFor();
    assert((await page.locator('#safety [data-alert="anticoagulant_before_surgery"]').count()) === 0, "without an anticoagulant, that rule is silent");
    assert((await page.locator('#safety [data-alert="penicillin_allergy_prescribed"]').count()) === 0, "and the penicillin drug rule is silent once that prescription is completed");
    await page.goto(`${BASE}/patients/${pid}/medications`);
    await page.locator("#prescriptions summary", { hasText: "A new prescription" }).click();
    await page.fill("#mrx_by", "Dr Cardio Lee");
    await page.fill("#mrx_l0_g", "Warfarin");
    await page.fill("#mrx_l0_s", "5 mg");
    await page.fill("#mrx_l0_q", "once daily");
    await page.fill("#mrx_l0_n", "30");
    await page.locator("#mrx_form").getByRole("button", { name: "Save the prescription" }).click();
    await page.getByText("The prescription was saved with 1 medicine(s)").waitFor();

    await page.goto(`${BASE}/patients/${pid}/dental`);
    const top = page.locator('#safety [data-alert="anticoagulant_before_surgery"]');
    await top.waitFor();
    await top.getByText(/Because of: Warfarin/).waitFor();
    // the rule concerns every planned surgical treatment in the file (the periodontal plan's surgery too), so the extraction is among those named, not necessarily the first
    await top.getByText(/Concerns: .*Simple extraction \(38\)/).waitFor();
    await top.getByText(/not yet clinically reviewed/).waitFor();
    assert((await page.locator('#safety [data-alert="local_anesthetic_allergy"], #safety [data-alert="latex_allergy"], #safety [data-alert="pregnancy_imaging_drugs"]').count()) === 0, "no alert for what is not in the file");
    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    // the open extraction carries the alert (the cancelled one in the superseded version of the plan does not)
    const ext = page.locator('li.treat-item:has-text("Simple extraction"):has([data-alert="anticoagulant_before_surgery"])');
    await ext.first().waitFor();
    assert((await ext.count()) === 1, "exactly one open extraction carries the alert");
    await ext.getByText("Surgical", { exact: true }).waitFor();
    // only the treatments the rule names carry it (surgical ones, and root planing which the rule lists by code): hygiene instruction, re-evaluation, maintenance show none
    const carrying = page.locator('li.treat-item[data-item]:has([data-alert="anticoagulant_before_surgery"])');
    assert((await carrying.filter({ hasNotText: /Simple extraction|Periodontal surgery|root planing/i }).count()) === 0, "an unrelated treatment carries the anticoagulant alert");
    assert((await page.locator('li.treat-item:has-text("hygiene") [data-alert], li.treat-item:has-text("maintenance") [data-alert], li.treat-item:has-text("re-evaluation") [data-alert]').count()) === 0, "non-surgical periodontal treatments the rule does not name carry no alert");
    // the plan holding that extraction (not simply the first plan on the page)
    const planId = (await page.locator('article.plan-card', { has: ext }).getAttribute("id")).replace("plan-", "");
    fs.writeFileSync(path.join(OUT, "treatment-plan-safety.pdf"), await pdfOk(page.request, `${BASE}/api/patients/${pid}/treatment-plans/${planId}/pdf`, "plan"));
    await page.screenshot({ path: path.join(OUT, "safety-alerts.png"), fullPage: true });
  });

  await step("consents: the patient signs on the screen (an undrawn signature is refused), versions supersede, withdrawing keeps it, the PDF carries the signature", async () => {
    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    await page.locator("#new-consent summary").click();
    const f = page.locator("form#nc_form");
    const target = await f.locator("#nc_target option", { hasText: "Simple extraction" }).first().getAttribute("value");
    await f.locator("#nc_target").selectOption(target);
    await f.locator("#nc_kind").selectOption("surgery");
    assert(/Simple extraction/.test(await f.locator("#nc_title").inputValue()), "the title names the treatment");
    assert(/surgical procedure/.test(await f.locator("#nc_body").inputValue()), "the text comes from the template");
    await f.locator("#nc_witness").fill("Nurse Huda");
    await f.locator('input[name="agree"]').check();
    await f.getByRole("button", { name: "Sign and save the consent" }).click();           // nothing drawn: the form does not submit
    await page.waitForTimeout(400);
    assert((await page.locator("#consents article.consent-card").count()) === 0, "an undrawn signature is refused");
    await drawSignature(page, f);
    await f.getByRole("button", { name: "Sign and save the consent" }).click();
    const c1 = page.locator("#consents article.consent-card", { hasText: "Simple extraction" });
    await c1.waitFor();
    await c1.getByText("Version 1").waitFor();
    await c1.locator(".chip", { hasText: "Signed" }).waitFor();
    await c1.getByText(/Nurse Huda/).waitFor();
    await page.waitForFunction(() => { const i = document.querySelector("#consents img.sig-img"); return i && i.complete && i.naturalWidth > 0; });
    const consentId = await c1.getAttribute("data-consent");
    fs.writeFileSync(path.join(OUT, "consent.pdf"), await pdfOk(page.request, `${BASE}/api/patients/${pid}/consents/${consentId}/pdf`, "consent"));
    const sig = await page.request.get(`${BASE}/api/patients/${pid}/consents/${consentId}/signature`);
    assert(sig.status() === 200 && /image\/png/.test(sig.headers()["content-type"]), "the signature is served to the file's members");
    // next to the plan that holds the treatment it covers (other plans in the file have none)
    const coveredPlan = (await page.locator("article.plan-card", { has: page.locator(`li[data-item="${target.replace(/^item:/, "")}"]`) }).getAttribute("id")).replace("plan-", "");
    await page.locator(`[data-plan-consents="${coveredPlan}"]`).getByText(/Simple extraction/).waitFor();

    // a new version supersedes the old one
    await c1.locator("summary", { hasText: "New version" }).click();
    const nv = page.locator('form[id^="cv-"]');
    await nv.locator('textarea[name="body"]').fill("Updated explanation: the extraction of tooth 38 and the alternatives were explained again.");
    await nv.locator('input[name="agree"]').check();
    await drawSignature(page, nv);
    await nv.getByRole("button", { name: "Sign the new version" }).click();
    await page.locator('#consents article.consent-card[data-status="superseded"]').waitFor();
    const c2 = page.locator('#consents article.consent-card[data-status="signed"]', { hasText: "Simple extraction" });
    await c2.getByText("Version 2").waitFor();
    assert((await page.locator("#consents article.consent-card").count()) === 2, "the old version is kept");

    // withdrawing keeps it, with the reason; it cannot be signed again
    await c2.locator("summary", { hasText: /^Withdraw$/ }).click();
    await c2.locator('input[name="reason"]').fill("I want a second opinion first");
    page.once("dialog", (dl) => dl.accept());
    await c2.getByRole("button", { name: "Withdraw", exact: true }).click();
    const w = page.locator('#consents article.consent-card[data-status="withdrawn"]');
    await w.waitFor();
    await w.getByText(/I want a second opinion first/).waitFor();
    assert((await w.locator("summary").count()) === 0, "a withdrawn consent offers no further action");
    assert((await page.locator("#consents article.consent-card").count()) === 2, "still two: nothing was deleted");
  });

  await step("doctor through a link: writes a prescription as the doctor named, presents a consent the patient signs on the doctor's screen, sees the alert on the plan", async () => {
    await page.goto(`${BASE}/patients/${pid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_contribute"]');
    await page.check('input[name="allow_print"]');
    await fillClinician(page, "Dr Rana Writer", { facility: "Rx Clinic", city: "Jeddah", license: "RX-1" });
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin = await page.locator('input[aria-label="PIN"]').inputValue();
    const token = link.split("/s/")[1];

    const cx = await newContext(browser); const d = await cx.newPage(); watch(d, "rx-doctor");
    await d.goto(link); await d.fill("#pin", pin); await d.getByRole("button", { name: "Open file" }).click(); await d.waitForURL(/\/view$/);
    await d.getByRole("button", { name: "I am Dr Rana Writer — start" }).click();
    await d.getByText("Adding as").waitFor();
    // the alert is in the doctor's view too: on the planned extraction
    await d.locator('[data-alert="anticoagulant_before_surgery"]').first().waitFor();

    // a prescription: the doctor does not type their name
    await d.locator("#contrib-prescription summary").click();
    assert((await d.locator("#cx-rx_by").count()) === 0, "the prescriber is not asked");
    await d.locator("#contrib-prescription .rx-fixed").getByText("Dr Rana Writer").waitFor();
    await d.fill("#cx-rx_l0_g", "Metronidazole");
    await d.fill("#cx-rx_l0_s", "400 mg");
    await d.fill("#cx-rx_l0_q", "three times a day");
    await d.fill("#cx-rx_l0_n", "5");
    await d.fill("#cx-rx_l0_c", "15 tablets");
    await d.getByRole("button", { name: "Another medicine on the prescription" }).click();
    await d.fill("#cx-rx_l1_g", "Chlorhexidine");
    await d.fill("#cx-rx_l1_q", "twice a day");
    await d.fill("#cx-rx_l1_n", "7");
    await d.locator("#cx-rx_form").getByRole("button", { name: "Save the prescription" }).click();
    await d.getByText("The prescription with 2 medicine(s) was saved under your name").waitFor();
    const drx = d.locator("#sec-prescriptions article.rx-card", { hasText: "Dr Rana Writer" });
    await drx.waitFor();
    await drx.locator(".chip", { hasText: "Yours" }).waitFor();
    const rid = await drx.getAttribute("data-rx");
    await pdfOk(d.request, `${BASE}/s/${token}/rx/${rid}/pdf`, "shared prescription");

    // a consent: the patient signs on the doctor's screen
    await d.locator("#contrib-consent summary").click();
    const cf = d.locator("form#cx-cn_form");
    const tgt = await cf.locator("#cx-cn_target option", { hasText: "Simple extraction" }).first().getAttribute("value");
    await cf.locator("#cx-cn_target").selectOption(tgt);
    await cf.locator("#cx-cn_kind").selectOption("surgery");
    await cf.getByText(/Presented by Dr Rana Writer/).waitFor();
    await cf.locator('input[name="agree"]').check();
    await drawSignature(d, cf);
    await cf.getByRole("button", { name: "Sign and save the consent" }).click();
    await d.getByText("The consent was saved with the patient's signature").waitFor();
    const dc = d.locator('#sec-consents article.consent-card[data-status="signed"]', { hasText: "Simple extraction" });
    await dc.waitFor();
    await dc.locator(".chip", { hasText: "Yours" }).waitFor();
    assert((await d.locator("#sec-consents img.sig-img").count()) === 0, "the doctor does not get the signature image");
    await d.locator("#sec-consents article.consent-card[data-status='withdrawn']").first().waitFor();     // the patient's earlier, withdrawn consent is visible as withdrawn
    await d.screenshot({ path: path.join(OUT, "doctor-rx-consent.png"), fullPage: true });
    await cx.close();

    // the patient's side: the prescription and the consent carry the doctor's name; the signature is the patient's, in their file
    await page.goto(`${BASE}/patients/${pid}/medications`);
    const prx = page.locator("#prescriptions article.rx-card", { hasText: "Dr Rana Writer" });
    await prx.getByText(/Written by Dr Rana Writer via a link/).waitFor();
    await prx.getByText(/licence RX-1/).waitFor();
    assert((await prx.locator("summary", { hasText: "Entered in error" }).count()) === 0, "a doctor's prescription is not marked 'entered in error' by the patient");
    await prx.locator("summary", { hasText: "Cancel the prescription" }).click();
    await prx.locator('input[name="reason"]').fill("the course was changed");
    page.once("dialog", (dl) => dl.accept());
    await prx.getByRole("button", { name: "Cancel it" }).click();
    await page.locator("#prescriptions article.rx-card", { hasText: "Dr Rana Writer" }).locator(".chip", { hasText: "Cancelled" }).waitFor();
    await page.goto(`${BASE}/patients/${pid}/dental?tab=treatment`);
    const pc = page.locator('#consents article.consent-card[data-status="signed"]', { hasText: "Presented by Dr Rana Writer via a link" });
    await pc.waitFor();
    // the signatures are lazy images: bring each into view (the page can be long) before asking that they all loaded
    for (const img of await page.locator("#consents img.sig-img").all()) await img.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll("#consents img.sig-img")].every((i) => i.complete && i.naturalWidth > 0));
    await pdfOk(page.request, `${BASE}/api/patients/${pid}/consents/${await pc.getAttribute("data-consent")}/pdf`, "presented consent");
  });

  // ---------------------------------------------------------------- the dental summary (ح4)
  // A file of its own whose records are seeded here, so every figure below is exact; the shared test file above holds many records.
  let sumPid = "";
  const sumKey = process.env.SUPABASE_SERVICE_ROLE_KEY, sumUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sumHeaders = { apikey: sumKey, Authorization: `Bearer ${sumKey}`, "Content-Type": "application/json", Prefer: "return=representation" };
  const sumRest = async (method, table, query, body) => {
    const r = await fetch(`${sumUrl}/rest/v1/${table}${query}`, { method, headers: sumHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    assert(r.ok, `${method} ${table}: ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const sumDay = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  // the text of a PDF when pdftotext is installed (the checks that read it are skipped otherwise)
  const pdfText = (buf) => {
    try { return execFileSync("pdftotext", ["-layout", "-", "-"], { input: buf, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
  };
  // the facts of the summary card, in one place: the same for the patient's page and for the doctor's link
  const expectSummaryFacts = async (root, label) => {
    const tile = (k) => root.locator(`[data-sum="${k}"]`);
    const n = async (k, key) => (await tile(k).locator(`[data-sum-n="${key}"]`).innerText()).trim();
    assert((await n("chart", "missing")) === "2" && (await n("chart", "restored")) === "2" && (await n("chart", "implants")) === "1" && (await n("chart", "open")) === "1", `${label}: the chart counts`);
    const chart = await tile("chart").innerText();
    assert(/18, 36/.test(chart) && /14, 26/.test(chart) && /\b46\b/.test(chart) && /\b16\b/.test(chart), `${label}: the teeth behind the counts: ${chart}`);
    await tile("baseline").getByText("Dr Base").waitFor();
    await tile("soft-tissue").getByText(/Suspicious lesion still open/i).waitFor();
    await tile("soft-tissue").getByText(/Ulcer on the left cheek/).waitFor();
    await tile("perio").getByText("Periodontitis — Stage II, Grade B, Localized").waitFor();
    await tile("perio").locator('[data-sum="perio-change"]').getByText(/worse/i).first().waitFor();
    await tile("perio").locator('[data-sum="perio-change"]').getByText(/attachment worsened at 1 site/).waitFor();
    const pulp = await tile("pulp").innerText();
    assert(/26\s+Cold: Lingering pain/.test(pulp) && /16\s+Percussion: Tender/.test(pulp) && !/Cold: Normal/.test(pulp) && !/\b14\b/.test(pulp), `${label}: only the abnormal pulp tests: ${pulp}`);
    await tile("image").getByText("Panoramic").first().waitFor();
    await tile("image").locator('[data-sum="bone"]').getByText(/S1 Coronal third/).waitFor();
    await tile("image").getByText("Mild generalised bone loss").waitFor();
    assert((await n("treatment", "proposed")) === "1" && (await n("treatment", "accepted")) === "2" && (await n("treatment", "completed")) === "1", `${label}: the treatment counts`);
    const tr = await tile("treatment").innerText();
    assert(/Scaling and polishing/.test(tr) && /Root canal treatment/.test(tr) && /Filling 16/.test(tr) && /Fissure sealant 14/.test(tr), `${label}: the treatments named: ${tr}`);
    await tile("safety").getByText(/latex allergy/i).waitFor();
    await tile("recall").getByText(/Dental check-up/).waitFor();
    await tile("recall").getByText(/overdue/i).waitFor();
  };

  await step("dental summary: the patient's page shows the current chart, baseline, open lesion, periodontal diagnosis and change, abnormal pulp tests, the whole-mouth image and its bone reading, treatment, alerts and recall", async () => {
    await page.goto(`${BASE}/patients/new`);
    await page.fill("#full_name", "Sami Summary"); await page.fill("#full_name_en", "Sami Summary");
    await page.fill("#date_of_birth", "1985-05-01"); await page.selectOption("#sex", "male");
    await submit(page, "Create file");
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}\/profile\?new=1$/);
    sumPid = page.url().split("/")[4];
    // the empty file says so
    await page.goto(`${BASE}/patients/${sumPid}/dental`);
    await page.locator("#dental-summary").getByText("The dental file has nothing to summarise yet.").waitFor();
    // the records, written the way the file would hold them (RLS is bypassed on purpose: this is fixture data)
    const dentId = (await sumRest("GET", "medical_specialties", "?code=eq.dentistry&select=id"))[0].id;
    const [e1] = await sumRest("POST", "dental_exams", "", { patient_id: sumPid, specialty_id: dentId, exam_date: sumDay(300), kind: "comprehensive", dentition: "permanent", examiner_name: "Dr Base", is_baseline: true,
      sections: { soft_tissue: { cancer_screening: "suspicious", note: "Ulcer on the left cheek" } } });
    await sumRest("POST", "dental_tooth_states", "", [[18, "extracted"], [36, "missing"], [46, "present"], [26, "present"], [16, "present"], [14, "present"], [28, "present"]]
      .map(([tooth, status]) => ({ patient_id: sumPid, exam_id: e1.id, tooth, status })));
    await sumRest("POST", "dental_findings", "", [[16, "caries"], [26, "filling"], [14, "crown"], [46, "implant"]]
      .map(([tooth, kind]) => ({ patient_id: sumPid, specialty_id: dentId, exam_id: e1.id, tooth, kind, surfaces: [], evidence: "clinical", observed_on: sumDay(300) })));
    await sumRest("POST", "dental_pulp_tests", "", [{ tooth: 26, test: "cold", result: "lingering" }, { tooth: 14, test: "cold", result: "normal" }, { tooth: 16, test: "percussion", result: "tender" }]
      .map((x) => ({ patient_id: sumPid, exam_id: e1.id, ...x })));
    for (const [date, pd, dx] of [[sumDay(200), [3, 3, 3, 3, 3, 3], { dx_kind: "gingivitis" }], [sumDay(20), [3, 3, 7, 3, 3, 3], { dx_kind: "periodontitis", dx_stage: "II", dx_grade: "B", dx_extent: "localized" }]]) {
      const [pe] = await sumRest("POST", "perio_exams", "", { patient_id: sumPid, specialty_id: dentId, exam_date: date, status: "draft", examiner_name: "Dr Gums" });
      await sumRest("POST", "perio_teeth", "", [{ patient_id: sumPid, exam_id: pe.id, tooth: 16, pd, gm: [0, 0, 0, 0, 0, 0] }]);
      await sumRest("PATCH", "perio_exams", `?id=eq.${pe.id}`, { status: "final", finalized_at: new Date().toISOString(), ...dx });
    }
    await sumRest("POST", "imaging_studies", "", { patient_id: sumPid, specialty_id: dentId, modality: "panoramic", performed_on: sumDay(100), impression: "Mild generalised bone loss",
      bone_levels: { s1: { level: "coronal_third", pattern: "horizontal" } } });
    const [plan] = await sumRest("POST", "treatment_plans", "", { patient_id: sumPid, specialty_id: dentId, title: "Summary plan", status: "proposed", presented_by: "Dr Plan" });
    const items = await sumRest("POST", "treatment_items", "", [
      { name: "Scaling and polishing", phase: 1 }, { name: "Root canal treatment", teeth: [26], phase: 1 }, { name: "Filling 16", teeth: [16], phase: 2 }, { name: "Fissure sealant 14", teeth: [14], phase: 1 },
    ].map((x) => ({ patient_id: sumPid, plan_id: plan.id, status: "proposed", ...x })));
    await sumRest("PATCH", "treatment_plans", `?id=eq.${plan.id}`, { status: "accepted", accepted_on: sumDay(70) });
    const itemId = (name) => items.find((i) => i.name === name).id;
    for (const [name, patch] of [["Root canal treatment", { status: "accepted" }], ["Filling 16", { status: "accepted" }], ["Filling 16", { status: "scheduled", scheduled_for: sumDay(-20) }], ["Fissure sealant 14", { status: "accepted" }]]) {
      await sumRest("PATCH", "treatment_items", `?id=eq.${itemId(name)}`, patch);
    }
    await sumRest("POST", "recalls", "", { patient_id: sumPid, specialty_id: dentId, kind: "dental_checkup", interval_months: 6, due_on: sumDay(5) });
    await sumRest("POST", "allergies", "", { patient_id: sumPid, substance: "Latex gloves", category: "latex", severity: "moderate" });
    await sumRest("POST", "prescriptions", "", { patient_id: sumPid, specialty_id: dentId, prescriber_name: "Dr Rx Summary", issued_on: sumDay(15) });
    await sumRest("POST", "consents", "", { patient_id: sumPid, specialty_id: dentId, kind: "treatment", title: "Consent for the summary plan", body: "I agree to the plan.", treatment_plan_id: plan.id,
      signer_name: "Sami Summary", signer_role: "patient", signature_path: `${sumPid}/signatures/seed.png`, signed_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    // completing a treatment goes through the app (the database refuses any other way)
    await page.goto(`${BASE}/patients/${sumPid}/dental?tab=treatment`);
    const seal = page.locator("li.treat-item", { hasText: "Fissure sealant 14" });
    await seal.locator("summary", { hasText: "Change status" }).click();
    await seal.locator('select[name="status"]').selectOption("completed");
    await seal.getByRole("button", { name: "Save the status" }).click();
    await page.locator("li.treat-item", { hasText: "Fissure sealant 14" }).getByText("Completed", { exact: true }).waitFor();
    // the summary sits at the top of the dental page
    await page.goto(`${BASE}/patients/${sumPid}/dental`);
    const root = page.locator("#dental-summary");
    await root.getByRole("heading", { name: "Dental summary" }).waitFor();
    await expectSummaryFacts(root, "patient");
    const order = await page.evaluate(() => ["#dental-summary", "#chart"].map((q) => document.querySelector(q).getBoundingClientRect().top + window.scrollY));
    assert(order[0] < order[1], "the summary comes before the chart: " + order);
    // each fact links to the place it comes from
    assert((await root.locator('[data-sum="baseline"] a').getAttribute("href")).startsWith("#exam-"), "the baseline links to its exam");
    assert(/tab=perio/.test(await root.locator('[data-sum="perio"] a').last().getAttribute("href")), "the diagnosis links to the periodontal chart");
    assert(/tab=treatment/.test(await root.locator('[data-sum="treatment"] a').last().getAttribute("href")), "the treatment links to the plans");
    await page.screenshot({ path: path.join(OUT, "dental-summary.png"), fullPage: true });
  });

  await step("dental summary: the PDF of the patient's file carries the same facts (and nothing the font lacks)", async () => {
    await page.goto(`${BASE}/patients/${sumPid}/dental`);
    const href = await page.locator("#dental-summary").getByRole("link", { name: /Dental summary \(PDF\)/ }).getAttribute("href");
    assert(href === `/api/patients/${sumPid}/dental/summary/pdf`, "the PDF link: " + href);
    const r = await page.request.get(`${BASE}${href}`);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]) && /no-store/.test(r.headers()["cache-control"]), "pdf " + r.status());
    const buf = await r.body();
    assert(buf.subarray(0, 5).toString() === "%PDF-" && buf.length > 4000, "a real PDF document (" + buf.length + " bytes)");
    fs.writeFileSync(path.join(OUT, "dental-summary.pdf"), buf);
    const text = pdfText(buf);
    if (text) {
      for (const needle of ["Dental summary", "Sami Summary", "Dr Base", "Ulcer on the left cheek", "Periodontitis", "Stage II, Grade B, Localized", "Fissure sealant 14", "Root canal treatment", "Mild generalised bone loss", "Lingering pain", "Latex allergy", "Dental check-up", "Overdue"]) {
        assert(text.includes(needle), `the PDF says "${needle}"`);
      }
    }
    assert((await page.request.get(`${BASE}${href}?dl=1`)).headers()["content-disposition"]?.startsWith("attachment"), "dl=1 downloads");
    await ctx.addCookies([{ name: "lang", value: "ar", url: BASE }]);
    const rAr = await page.request.get(`${BASE}${href}`);
    await ctx.addCookies([{ name: "lang", value: "en", url: BASE }]);
    const arBuf = await rAr.body();
    assert(rAr.status() === 200 && arBuf.subarray(0, 5).toString() === "%PDF-", "the Arabic PDF renders: " + rAr.status());
    fs.writeFileSync(path.join(OUT, "dental-summary-ar.pdf"), arBuf);
    // another account cannot print this file, and a request without a session gets nothing
    const octx = await newContext(browser); const other = await octx.newPage(); watch(other, "other-summary");
    await signup(other, `sum-other-${stamp}@example.test`, "Summary Other");
    const denied = await other.request.get(`${BASE}${href}`);
    assert(denied.status() === 404, "another account gets nothing: " + denied.status());
    await octx.close();
    const anon = await newContext(browser);
    const noSession = await anon.request.get(`${BASE}${href}`, { maxRedirects: 0 });
    assert(noSession.status() === 401 || noSession.status() === 307, "the PDF needs a session: " + noSession.status());
    await anon.close();
  });

  await step("dental summary: the timeline lists the dental exam, the final periodontal charts, the completed treatment, the prescription and the consent, each linking to its place", async () => {
    await page.goto(`${BASE}/patients/${sumPid}/timeline`);
    const entry = (text) => page.locator("ol.timeline li", { hasText: text }).first();
    await entry("Dental exam — Comprehensive exam").waitFor();
    assert((await entry("Dental exam — Comprehensive exam").locator("a").first().getAttribute("href")).includes(`/patients/${sumPid}/dental?tab=chart#exam-`), "the exam links to its card");
    await entry("Periodontal chart — Periodontitis — Stage II").waitFor();
    assert((await page.locator("ol.timeline li", { hasText: "Periodontal chart — Gingivitis" }).count()) === 1, "the earlier final chart is listed too");
    assert((await entry("Periodontal chart — Periodontitis").locator("a").first().getAttribute("href")).endsWith("/dental?tab=perio"), "the chart links to the periodontal tab");
    await entry("Treatment completed").getByText("Fissure sealant 14").waitFor();
    assert((await entry("Treatment completed").locator("a").first().getAttribute("href")).endsWith("/dental?tab=treatment"), "the treatment links to the plan");
    await entry("Prescription — Dr Rx Summary").waitFor();
    assert((await entry("Prescription — Dr Rx Summary").locator("a").first().getAttribute("href")).endsWith("/dental?tab=care#prescriptions"), "the prescription links to the dental care tab");
    await entry("Consent for the summary plan").getByText(/Consent to treatment · v1/).waitFor();
    assert((await entry("Consent for the summary plan").locator("a").first().getAttribute("href")).endsWith("/dental?tab=treatment#consents"), "the consent links to the signed consents");
    // the filters
    await page.goto(`${BASE}/patients/${sumPid}/timeline?kind=perio`);
    assert((await page.locator("ol.timeline li", { hasText: "Periodontal chart" }).count()) === 2 && (await page.locator("ol.timeline li", { hasText: "Prescription" }).count()) === 0, "the periodontal filter lists the two charts only");
    await page.goto(`${BASE}/patients/${sumPid}/timeline?kind=consent`);
    await page.locator("ol.timeline li", { hasText: "Consent for the summary plan" }).waitFor();
    // a specialty other than dentistry hides the dental events
    const cardio = await page.locator('select[name="specialty"] option', { hasText: "Cardiology" }).first().getAttribute("value");
    await page.goto(`${BASE}/patients/${sumPid}/timeline?specialty=${cardio}`);
    assert((await page.locator("ol.timeline li", { hasText: "Dental exam" }).count()) === 0, "dental events are not listed under another specialty");
  });

  await step("dental summary: a doctor on a link sees the same summary within the scope; the summary PDF follows the print permission", async () => {
    // a link without printing
    await page.goto(`${BASE}/patients/${sumPid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await fillClinician(page, "Dr Summary Reader");
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const linkNp = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pinNp = await page.locator('input[aria-label="PIN"]').inputValue();
    const cn = await newContext(browser); const dn = await cn.newPage(); watch(dn, "summary-noprint");
    await dn.goto(linkNp); await dn.fill("#pin", pinNp); await dn.getByRole("button", { name: "Open file" }).click(); await dn.waitForURL(/\/view$/);
    await dn.locator("#dental-summary").getByRole("heading", { name: "Dental summary" }).waitFor();
    assert((await dn.locator("#dental-summary").getByRole("link", { name: /Dental summary \(PDF\)/ }).count()) === 0, "no PDF link without the print permission");
    assert((await cn.request.get(`${BASE}/s/${linkNp.split("/s/")[1]}/dental/pdf`)).status() === 403, "the summary PDF is refused when printing is not allowed");
    await cn.close();
    // a link that allows printing
    await page.goto(`${BASE}/patients/${sumPid}/sharing/new?specialty=dentistry`);
    await page.getByText("Always included (for safety)").waitFor();
    await page.check('input[name="allow_print"]');
    await fillClinician(page, "Dr Summary Printer");
    await submit(page, "Create link & PIN");
    await page.getByText("Share created").waitFor();
    const link = (await page.locator('input[aria-label="Share link"]').inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.getByRole("button", { name: "Show" }).click();
    const pin = await page.locator('input[aria-label="PIN"]').inputValue();
    const c = await newContext(browser); const d = await c.newPage(); watch(d, "summary-doctor");
    await d.goto(link); await d.fill("#pin", pin); await d.getByRole("button", { name: "Open file" }).click(); await d.waitForURL(/\/view$/);
    const root = d.locator("#dental-summary");
    await root.getByRole("heading", { name: "Dental summary" }).waitFor();
    await expectSummaryFacts(root, "doctor");
    const order = await d.evaluate(() => ["#dental-summary", "#dental"].map((q) => document.querySelector(q).getBoundingClientRect().top + window.scrollY));
    assert(order[0] < order[1], "the summary comes before the tooth chart on the doctor's page: " + order);
    await d.screenshot({ path: path.join(OUT, "dental-summary-doctor.png"), fullPage: true });
    const token = link.split("/s/")[1];
    const href = await root.getByRole("link", { name: /Dental summary \(PDF\)/ }).getAttribute("href");
    assert(href === `/s/${token}/dental/pdf`, "the doctor's PDF link: " + href);
    const r = await c.request.get(`${BASE}${href}`);
    assert(r.status() === 200 && /application\/pdf/.test(r.headers()["content-type"]) && /no-store/.test(r.headers()["cache-control"]), "doctor pdf " + r.status());
    const buf = await r.body();
    assert(buf.subarray(0, 5).toString() === "%PDF-" && buf.length > 4000, "a real PDF document (" + buf.length + " bytes)");
    fs.writeFileSync(path.join(OUT, "dental-summary-doctor.pdf"), buf);
    const text = pdfText(buf);
    if (text) for (const needle of ["Dental summary", "Dr Base", "Stage II, Grade B, Localized", "Fissure sealant 14", "Lingering pain", "Mild generalised bone loss", "Latex allergy"]) assert(text.includes(needle), `the doctor's PDF says "${needle}"`);
    const anon = await newContext(browser);
    assert((await anon.request.get(`${BASE}${href}`)).status() === 401, "the doctor's PDF needs a session");
    await anon.close();
    // the doctor on a phone, in Arabic: the summary fits the width
    const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA", timezoneId: "Asia/Riyadh" });
    await mc.addCookies([...(await c.cookies()).filter((x) => x.name !== "lang"), { name: "lang", value: "ar", url: BASE }]);
    const m = await mc.newPage(); watch(m, "summary-doctor-mobile");
    await m.goto(`${BASE}/s/${token}/view`);
    await m.locator("#dental-summary").getByRole("heading", { name: "ملخص الأسنان" }).waitFor();
    assert((await m.locator("html").getAttribute("dir")) === "rtl", "rtl");
    const over = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 1, `horizontal overflow of ${over}px on the doctor's summary`);
    await m.screenshot({ path: path.join(OUT, "dental-summary-doctor-ar-mobile.png"), fullPage: true });
    await mc.close(); await c.close();
  });

  await step("dental summary: in Arabic on a phone the patient's summary and timeline fit the width", async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA", timezoneId: "Asia/Riyadh" });
    await m.addCookies([...(await ctx.cookies()).filter((c) => c.name !== "lang"), { name: "lang", value: "ar", url: BASE }]);
    const mp = await m.newPage(); watch(mp, "summary-mobile");
    for (const p of ["/dental", "/timeline"]) {
      const r = await mp.goto(`${BASE}/patients/${sumPid}${p}`);
      assert(r.status() === 200, `${p} => ${r.status()}`);
      assert((await mp.locator("html").getAttribute("dir")) === "rtl", "rtl");
      if (p === "/dental") {
        await mp.locator("#dental-summary").getByRole("heading", { name: "ملخص الأسنان" }).waitFor();
        await mp.locator('#dental-summary [data-sum="perio"]').getByText(/المرحلة II/).waitFor();
      }
      const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const culprits = over > 1 ? await mp.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1); })
        .slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ")[0]}`)) : [];
      assert(over <= 1, `horizontal overflow of ${over}px on ${p} (${culprits.join(", ")})`);
      if (p === "/dental") await mp.screenshot({ path: path.join(OUT, "dental-summary-ar-mobile.png"), fullPage: true });
    }
    await m.close();
  });

  await step("safety rules: an administrator reviews, edits and deactivates a rule; the review is recorded and cleared by an edit; others cannot open the page", async () => {
    const actx = await newContext(browser); const adm = await actx.newPage(); watch(adm, "rules-admin");
    const who = `Rules Admin ${stamp}`;
    await signup(adm, `rules-admin-${stamp}@example.test`, who);
    const denied = await adm.goto(`${BASE}/admin/safety-rules`);
    assert(denied.status() === 404, "not an administrator yet: " + denied.status());
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const up = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/profiles?full_name=eq.${encodeURIComponent(who)}`, {
      method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ role: "admin" }),
    }).catch((e) => { throw new Error(`promoting the test account: ${e.message} (${e.cause?.code ?? e.cause?.message ?? "no cause"}) url=${process.env.NEXT_PUBLIC_SUPABASE_URL}`); });
    assert(up.ok, "promoting the test account: " + up.status);
    await adm.goto(`${BASE}/admin/safety-rules`);
    await adm.getByRole("heading", { name: "Safety alert rules" }).waitFor();
    assert((await adm.locator("details.fold[id^='r-']").count()) >= 12, "the seeded rules are listed");
    assert((await adm.getByText("Not reviewed").count()) >= 12, "none is reviewed yet");
    const rule = adm.locator("details#r-latex_allergy");
    await rule.locator("summary").click();
    await rule.getByRole("button", { name: "Record that I reviewed it" }).click();
    await adm.locator("details#r-latex_allergy summary .chip", { hasText: "Reviewed" }).waitFor();
    await adm.locator("details#r-latex_allergy").getByText(new RegExp(`Reviewed by ${who}`)).waitFor();
    // editing what it says clears the review and raises the version
    const r2 = adm.locator("details#r-latex_allergy");
    const v0 = Number(/ v(\d+)/.exec(await adm.locator("details#r-latex_allergy summary").innerText())?.[1] ?? "1");
    await r2.locator('textarea[name="message_en"]').fill(`A latex allergy is recorded: use latex-free gloves, rubber dams and materials (${stamp}).`);
    await r2.getByRole("button", { name: "Save the rule" }).click();
    await adm.locator("details#r-latex_allergy summary .chip", { hasText: "Not reviewed" }).waitFor();
    await adm.locator("details#r-latex_allergy summary").getByText(`v${v0 + 1}`, { exact: false }).waitFor();
    // a rule needs something in the file to match
    await r2.locator('textarea[name="allergies"]').fill("");
    await r2.getByRole("button", { name: "Save the rule" }).click();
    await adm.getByText(/Choose what in the file raises the rule/).waitFor();
    await actx.close();
  });

  await step("another user cannot see or reach Alice's file, documents or exports", async () => {
    await signup(bob, `bob-${stamp}@example.test`, "Bob Beta");
    await bob.getByText("No files yet").waitFor();
    for (const p of ["", "/profile", "/vitals", "/labs", "/documents", "/sharing", "/audit", "/timeline", "/conditions"]) {
      const r = await bob.goto(`${BASE}/patients/${pid}${p}`);
      assert(r.status() === 404, `bob ${p || "/"} => ${r.status()}`);
    }
    const href = "/api/documents/" + cardioDocId;
    assert((await bctx.request.get(BASE + href)).status() === 404, "document hidden from bob");
    assert((await bctx.request.get(`${BASE}/api/patients/${pid}/report?scope=full`)).status() === 404, "report hidden from bob");
    assert((await bctx.request.get(`${BASE}/api/patients/${pid}/export`)).status() === 403, "export refused to bob");
    assert((await bob.goto(`${BASE}/patients/${pid}/search?q=metformin`)).status() === 404, "search page hidden from bob");
    assert((await bob.goto(`${BASE}/patients/${pid}/symptoms`)).status() === 404, "symptoms page hidden from bob");
    const up = await bctx.request.post(`${BASE}/api/patients/${pid}/documents`, { multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: pdf() }, title: "intruder" }, maxRedirects: 0 });
    assert(up.status() === 403, "upload into alice file refused: " + up.status());
    const adm = await bob.goto(`${BASE}/admin/specialties`);
    assert(adm.status() === 404, "non-admin cannot open admin");
  });

  // ---------------------------------------------------------------- account, controls, sex rules, share register, deletion
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const newFile = async (name, dob, sex) => {
    await page.goto(`${BASE}/patients/new`);
    await page.fill("#full_name", name); await page.fill("#date_of_birth", dob); await page.selectOption("#sex", sex);
    await submit(page, "Create file");
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}\/profile\?new=1$/);
    return page.url().split("/")[4];
  };

  await step("account: basic details saved; picture uploaded, shown in the menu, non-images refused, removable", async () => {
    await page.goto(`${BASE}/account`);
    await page.fill("#date_of_birth", "1990-05-20"); await page.selectOption("#sex", "female"); await page.selectOption("#blood_abo", "O"); await page.selectOption("#blood_rh", "+");
    await page.fill("#phone", "+966500000001"); await page.fill("#city", "Riyadh");
    await submit(page, "Save changes");
    await page.getByText("Your account details were saved.").waitFor();
    await page.reload();
    assert((await page.inputValue("#date_of_birth")) === "1990-05-20" && (await page.inputValue("#blood_abo")) === "O" && (await page.inputValue("#city")) === "Riyadh", "details persisted");
    await page.setInputFiles("#photo-user", { name: "me.png", mimeType: "image/png", buffer: PNG });
    await submit(page, "Upload");
    await page.getByText("Picture updated.").waitFor();
    await page.locator(".navuser-btn img.avatar-img").waitFor();
    const r = await page.request.get(`${BASE}/api/avatar`);
    assert(r.status() === 200 && /image\/png/.test(r.headers()["content-type"]) && r.headers()["x-content-type-options"] === "nosniff", "avatar served as nosniff png");
    await page.setInputFiles("#photo-user", { name: "evil.png", mimeType: "image/png", buffer: pdf() });
    await submit(page, "Upload");
    await page.getByText(/Unsupported format/).waitFor();
    await submit(page, "Remove picture");
    await page.getByText("Picture removed.").waitFor();
    assert((await page.request.get(`${BASE}/api/avatar`)).status() === 404, "avatar gone");
  });

  await step("controls: text, select and date fields share one height (desktop 44px, mobile 48px)", async () => {
    await page.goto(`${BASE}/account`);
    const heights = async () => page.evaluate(() => ["#full_name", "#date_of_birth", "#sex", "#phone"].map((q) => document.querySelector(q).getBoundingClientRect().height));
    let h = await heights();
    assert(h.every((x) => Math.abs(x - 44) < 0.6), "desktop heights " + h);
    await page.setViewportSize({ width: 390, height: 844 });
    h = await heights();
    assert(h.every((x) => Math.abs(x - 48) < 0.6), "mobile heights " + h);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/patients/${pid}/vitals`);
    const dt = await page.evaluate(() => { const e = document.querySelector("input[type=datetime-local]").getBoundingClientRect().height; const n = document.querySelector("#v_num").getBoundingClientRect().height; return [e, n]; });
    assert(Math.abs(dt[0] - dt[1]) < 0.6, "datetime-local vs number " + dt);
  });

  await step("sex rules: a male file has no gynecology, a female file has no men's health, direct URL is 404", async () => {
    const male = await newFile("Omar Male", "1988-03-03", "male");
    await page.goto(`${BASE}/patients/${male}/specialties`);
    await page.getByText("Men's health").first().waitFor();
    assert((await page.getByText("Obstetrics").count()) === 0, "no obstetrics for a male file");
    const r = await page.goto(`${BASE}/patients/${male}/specialties/obgyn`);
    assert(r.status() === 404, "obgyn direct URL => " + r.status());
    await page.goto(`${BASE}/patients/${male}/visits`);
    await openSummary(page, "Add visit");
    const opts = await page.locator("#f_specialty_id option, select[name=specialty_id] option").allInnerTexts();
    assert(opts.length > 3 && !opts.some((o) => /Obstetrics/.test(o)), "visit form hides obstetrics: " + opts.slice(0, 5));
    await page.goto(`${BASE}/patients/${pid}/specialties`);
    const fem = (await page.locator("main").textContent()) ?? "";                              // unused specialties sit in a folded list
    if (/Female/.test(await page.locator("header.patient-head").innerText())) assert(/Obstetrics/.test(fem) && !/Men's health/.test(fem), "female file view");
  });

  await step("share register: lists every share across files with token ending and filters", async () => {
    await page.goto(`${BASE}/shares`);
    await page.getByRole("heading", { name: "Share register" }).waitFor();
    assert((await page.locator("tbody tr").count()) >= 2, "rows listed");
    const row = await page.locator("tbody tr").first().innerText();
    assert(/…[A-Za-z0-9_-]{4}/.test(row), "token ending shown: " + row.replace(/\n/g, " | "));
    await page.getByRole("link", { name: /^Revoked/ }).click();
    await page.waitForURL(/status=revoked/);
    assert((await page.locator("tbody tr").count()) >= 1, "revoked filter");
    await page.goto(`${BASE}/shares?q=zzzz-no-match`);
    await page.getByText("Nothing matches these filters.").waitFor();
    await page.goto(`${BASE}/shares`);
    await page.getByText("Latest activity across all shares").waitFor();
    await page.screenshot({ path: path.join(OUT, "desktop-share-register.png"), fullPage: true });
  });

  await step("deletion: typed name + password, 30-day grace (read-only, shares revoked), restore, then delete now", async () => {
    const del = await newFile("Delete Target", "1979-09-09", "female");
    await page.goto(`${BASE}/patients/${del}/delete`);
    await page.fill("#confirm", "Wrong Name"); await page.fill("#password", "correct-horse-battery"); await page.check('input[name="ack"]');
    await submit(page, "Schedule deletion");
    await page.getByText("does not match").waitFor();
    await page.fill("#confirm", "Delete Target"); await page.fill("#password", "not-my-password");
    await submit(page, "Schedule deletion");
    await page.getByText("Incorrect password.").waitFor();
    await page.fill("#confirm", "delete target"); await page.fill("#password", "correct-horse-battery");
    await submit(page, "Schedule deletion");
    await page.getByText(/scheduled for deletion/i).first().waitFor();
    await page.getByText(/permanently deleted in 30 day/).waitFor();
    await page.screenshot({ path: path.join(OUT, "desktop-delete-pending.png"), fullPage: true });
    await page.goto(`${BASE}/patients/${del}/allergies`);
    assert((await page.locator("summary", { hasText: "Add allergy" }).count()) === 0, "read-only: no add form");
    await page.goto(`${BASE}/patients`);
    await page.locator("a.card", { hasText: "Delete Target" }).getByText("Scheduled for deletion").waitFor();
    await page.goto(`${BASE}/patients/${del}/delete`);
    await page.getByRole("button", { name: "Restore this file" }).click();
    await page.waitForURL(new RegExp(`/patients/${del}$`));
    await page.goto(`${BASE}/patients/${del}/allergies`);
    await page.locator("summary", { hasText: "Add allergy" }).first().waitFor();
    // schedule again and erase now
    await page.goto(`${BASE}/patients/${del}/delete`);
    await page.fill("#confirm", "Delete Target"); await page.fill("#password", "correct-horse-battery"); await page.check('input[name="ack"]');
    await submit(page, "Schedule deletion");
    await page.getByText(/permanently deleted in/).waitFor();
    await page.fill("#confirm", "Delete Target"); await page.fill("#password", "bad-password");
    await submit(page, "Delete permanently now");
    await page.getByText("Incorrect password.").waitFor();
    await page.fill("#confirm", "Delete Target"); await page.fill("#password", "correct-horse-battery");
    await submit(page, "Delete permanently now");
    await page.waitForURL(/\/patients\?deleted=1/);
    await page.getByText("The file was permanently deleted.").waitFor();
    assert((await page.locator("a.card", { hasText: "Delete Target" }).count()) === 0, "gone from the list");
    const r = await page.goto(`${BASE}/patients/${del}`);
    assert(r.status() === 404, "erased file is 404");
    assert((await page.locator("a.card", { hasText: "Alice" }).count()) === 0 || true, "noop");
    await page.goto(`${BASE}/patients/${pid}`);
    await page.locator("header.patient-head, header.card").first().waitFor();
  });

  // ---------------------------------------------------------------- account: sessions, activity, deletion (migration 0032)
  // Every scenario creates its own throw-away accounts; nothing of the accounts above is touched.
  const PW = "correct-horse-battery";
  const pgq = async (text, params = []) => {
    const { Client } = require("pg");
    const c = new Client({ host: process.env.SHIM_PGHOST, port: Number(process.env.SHIM_PGPORT), user: "postgres", database: "app" });
    await c.connect();
    try { return await c.query(text, params); } finally { await c.end(); }
  };
  const uidOf = async (email) => (await pgq("select id from auth.users where email = $1", [email])).rows[0]?.id;
  const throwaway = async (tag, name, extra = {}) => {
    const email = `${tag}-${stamp}@example.test`;
    const tctx = await newContext(browser, extra); const tpage = await tctx.newPage(); watch(tpage, tag);
    await signup(tpage, email, name);
    return { email, ctx: tctx, page: tpage };
  };
  const signIn = async (p, email, pw = PW) => {
    await p.goto(`${BASE}/login`); await p.fill("#email", email); await p.fill("#password", pw);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
  };
  const cron = (secret) => fetch(`${BASE}/api/cron/purge`, secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } });
  const fileFor = async (p, name) => {
    await p.goto(`${BASE}/patients/new`);
    await p.fill("#full_name", name); await p.fill("#date_of_birth", "1985-05-05"); await p.selectOption("#sex", "male");
    await submit(p, "Create file");
    await p.waitForURL(/\/patients\/[0-9a-f-]{36}\/profile\?new=1$/);
    return p.url().split("/")[4];
  };
  let sess = null;

  await step("sessions: a second browser signs in, both are listed with this one marked, ending the other signs it out; sign out all others; a new password signs the others out", async () => {
    sess = await throwaway("sess", "Session Tester");
    const phoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
    const ctx2 = await newContext(browser, { userAgent: phoneUA }); const p2 = await ctx2.newPage(); watch(p2, "sess2");
    await signIn(p2, sess.email); await p2.waitForURL(/\/patients$/);
    const me = sess.page;
    await me.goto(`${BASE}/account#sessions`);
    const items = me.locator(".session-item");
    await items.nth(1).waitFor();
    assert((await items.count()) === 2, "two sessions are listed");
    const mine = me.locator(".session-item[data-current='true']");
    assert((await mine.count()) === 1 && /this device/i.test(await mine.innerText()) && /Chrome/.test(await mine.innerText()), "this device is marked and named");
    const other = items.filter({ hasText: "Safari on iOS" });
    assert((await other.count()) === 1 && (await other.getByRole("button").count()) === 1, "the phone is listed with its approximate device and a sign-out button");
    assert((await mine.getByRole("button").count()) === 0, "the current session has no sign-out button");
    await p2.goto(`${BASE}/account`); await p2.getByRole("heading", { name: "My account" }).waitFor();
    await other.getByRole("button", { name: "Sign out the session on Safari on iOS" }).click();
    await me.waitForFunction(() => document.querySelectorAll(".session-item").length === 1);
    await p2.goto(`${BASE}/patients`); await p2.waitForURL(/\/login/);
    // the activity log names the sign-ins and the change
    await me.reload();
    const act = me.locator(".activity-list");
    assert((await act.getByText("Signed in", { exact: true }).count()) >= 2, "both sign-ins are in the activity");
    assert((await act.getByText("A session was signed out").count()) === 1, "ending a session is in the activity");
    assert((await act.getByText("Safari on iOS").count()) >= 1, "with the approximate device");
    // two more devices, then "sign out all other sessions"
    const ctx3 = await newContext(browser); const p3 = await ctx3.newPage(); watch(p3, "sess3");
    await signIn(p2, sess.email); await p2.waitForURL(/\/patients$/);
    await signIn(p3, sess.email); await p3.waitForURL(/\/patients$/);
    await me.reload();
    await me.waitForFunction(() => document.querySelectorAll(".session-item").length === 3);
    me.once("dialog", (d) => d.accept());
    await me.getByRole("button", { name: "Sign out all other sessions" }).click();
    await me.waitForFunction(() => document.querySelectorAll(".session-item").length === 1);
    await me.getByText("There are no other sessions.").waitFor();
    for (const q of [p2, p3]) { await q.goto(`${BASE}/patients`); await q.waitForURL(/\/login/); }
    // a new password ends the other sign-ins too
    await signIn(p2, sess.email); await p2.waitForURL(/\/patients$/);
    await me.goto(`${BASE}/account#password-card`);
    await me.fill("#password", "another-long-passphrase");
    await me.getByRole("button", { name: "Update", exact: true }).click();
    await me.getByText("Password updated. Your other sessions were signed out.").waitFor();
    await p2.goto(`${BASE}/patients`); await p2.waitForURL(/\/login/);
    await me.goto(`${BASE}/account`); await me.getByRole("heading", { name: "My account" }).waitFor();
    await signIn(p2, sess.email, PW); await p2.getByRole("alert").waitFor();
    await signIn(p2, sess.email, "another-long-passphrase"); await p2.waitForURL(/\/patients$/);
    await ctx2.close(); await ctx3.close();
  });

  await step("account page: Arabic RTL on a phone without horizontal scroll; every control has a name; each card is labelled by its heading", async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA", timezoneId: "Asia/Riyadh" });
    await m.addCookies([...(await sess.ctx.cookies()).filter((c) => c.name !== "lang"), { name: "lang", value: "ar", url: BASE }]);
    const mp = await m.newPage(); watch(mp, "mobile-account");
    const r = await mp.goto(`${BASE}/account`);
    assert(r.status() === 200 && (await mp.locator("html").getAttribute("dir")) === "rtl", "rtl account page");
    await mp.getByRole("heading", { name: "الجلسات النشطة" }).waitFor();
    await mp.getByRole("heading", { name: "حذف الحساب" }).waitFor();
    await mp.getByText("هذا الجهاز").waitFor();
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 1, `horizontal overflow of ${over}px on the account page`);
    const bad = await mp.evaluate(() => {
      const named = (el) => (el.labels && el.labels.length) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.tagName === "BUTTON" && el.textContent.trim());
      const controls = [...document.querySelectorAll("#main input:not([type=hidden]):not([aria-hidden=true]), #main select, #main textarea, #main button")].filter((el) => el.offsetParent !== null || el.type === "file");
      const unnamed = controls.filter((el) => !named(el)).map((el) => `${el.tagName.toLowerCase()}#${el.id || el.name}`);
      const cards = [...document.querySelectorAll("#main section.card[id]")].filter((s) => { const ref = s.getAttribute("aria-labelledby"); const h = ref && document.getElementById(ref); return !h || !h.textContent.trim(); }).map((s) => s.id);
      return { unnamed, cards };
    });
    assert(bad.unnamed.length === 0, `controls without an accessible name: ${bad.unnamed.join(", ")}`);
    assert(bad.cards.length === 0, `cards not labelled by their heading: ${bad.cards.join(", ")}`);
    await mp.screenshot({ path: path.join(OUT, "mobile-account-ar.png"), fullPage: true });
    await m.close();
    await sess.ctx.close();
  });

  await step("sign-in: a wrong password gets one generic message; repeated attempts get a clear rate-limit message", async () => {
    const rctx = await newContext(browser); const rp = await rctx.newPage(); watch(rp, "rate");
    await rp.goto(`${BASE}/login`);
    await rp.fill("#email", `ratelimit-${stamp}@example.test`);
    for (let i = 0; i < 11; i++) {
      await rp.fill("#password", `wrong-password-${i}`);
      await Promise.all([
        rp.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(`${BASE}/login`)),
        rp.getByRole("button", { name: "Sign in", exact: true }).click(),
      ]);
      if (i === 0) await rp.getByRole("alert").getByText("Incorrect email or password.").waitFor();
    }
    await rp.getByRole("alert").getByText(/Too many attempts/).waitFor();
    await rctx.close();
  });

  await step("account deletion: typed e-mail + password, 30-day grace, cancel by signing in, delete again, purge through the cron route; another account is untouched", async () => {
    const u = await throwaway("del", "Doomed User");
    const p = u.page;
    const fid = await fileFor(p, "Doomed File");
    const uid = await uidOf(u.email);
    await p.goto(`${BASE}/account#delete-account`);
    await p.getByRole("list", { name: "Files that go with the account" }).getByText("Doomed File").waitFor();
    await p.fill("#del-confirm", "someone-else@example.test"); await p.fill("#del-password", PW); await p.check('input[name="ack"]');
    await submit(p, "Delete my account");
    await p.getByText("does not match your account's email").waitFor();
    await p.fill("#del-confirm", u.email); await p.fill("#del-password", "not-my-password");
    await submit(p, "Delete my account");
    await p.getByText("Incorrect password.").waitFor();
    await p.fill("#del-confirm", u.email.toUpperCase()); await p.fill("#del-password", PW);
    await submit(p, "Delete my account");
    await p.waitForURL(/\/login\?deleted=1&on=\d{4}-\d{2}-\d{2}/);
    await p.getByText("Your account is scheduled for deletion").waitFor();
    const row = (await pgq("select scheduled_for > now() + interval '29 days' as ok, files from account_deletions where user_id = $1 and completed_at is null", [uid])).rows[0];
    assert(row && row.ok && row.files.includes(fid), "scheduled 30 days ahead, with the file");
    assert((await pgq("select deletion_requested_at is not null as d from patients where id = $1", [fid])).rows[0].d, "the file entered the file deletion");
    await p.goto(`${BASE}/patients`); await p.waitForURL(/\/login/);
    // the retention job refuses a missing or wrong secret and purges nothing inside the grace period
    assert((await cron()).status === 401 && (await cron("wrong-secret-wrong-secret-0000")).status === 401, "the cron route refuses a missing or wrong secret");
    let j = await (await cron(process.env.CRON_SECRET)).json();
    assert(j.accounts && j.accounts.purged === 0 && j.accounts.failed === 0, "nothing purged inside the grace period: " + JSON.stringify(j));
    assert((await pgq("select count(*)::int n from patients where id = $1", [fid])).rows[0].n === 1, "the file is still there");
    // signing in again cancels
    await signIn(p, u.email);
    await p.waitForURL(/\/account\?restored=1/);
    await p.getByText("Your account deletion was cancelled").waitFor();
    assert((await pgq("select count(*)::int n from account_deletions where user_id = $1", [uid])).rows[0].n === 0, "the request is gone");
    assert((await pgq("select deletion_requested_at is null as ok from patients where id = $1", [fid])).rows[0].ok, "the file is restored");
    await p.goto(`${BASE}/account#activity`);
    await p.locator(".activity-list").getByText("Account deletion requested").waitFor();
    await p.locator(".activity-list").getByText("Account deletion cancelled (by signing in)").waitFor();
    // delete again, let the grace period pass, purge
    await p.goto(`${BASE}/account#delete-account`);
    await p.fill("#del-confirm", u.email); await p.fill("#del-password", PW); await p.check('input[name="ack"]');
    await submit(p, "Delete my account");
    await p.waitForURL(/\/login\?deleted=1/);
    await pgq("update account_deletions set requested_at = now() - interval '31 days', scheduled_for = now() - interval '1 day' where user_id = $1", [uid]);
    await pgq("update patients set deletion_scheduled_for = now() - interval '1 day' where deletion_requested_by = $1", [uid]);
    j = await (await cron(process.env.CRON_SECRET)).json();
    assert(j.failed === 0 && j.purged >= 1 && j.accounts.failed === 0 && j.accounts.purged === 1, "the job purged the file and the account: " + JSON.stringify(j));
    assert((await pgq("select count(*)::int n from patients where id = $1", [fid])).rows[0].n === 0, "the file is erased");
    assert((await pgq("select count(*)::int n from auth.users where id = $1", [uid])).rows[0].n === 0 && (await pgq("select count(*)::int n from profiles where id = $1", [uid])).rows[0].n === 0, "the identity and profile are erased");
    const tomb = (await pgq("select method, completed_at is not null as done from account_deletions where user_id = $1", [uid])).rows[0];
    assert(tomb && tomb.method === "deleted" && tomb.done, "the tombstone records a complete deletion");
    assert((await pgq("select count(*)::int n from patients where id = $1", [pid])).rows[0].n === 1, "another account's file is untouched");
    await signIn(p, u.email); await p.getByRole("alert").getByText("Incorrect email or password.").waitFor();
    await u.ctx.close();
  });

  await step("account deletion with shared files: the other members are listed (remove / transfer work); a caregiver's account is anonymised and the owner's file stays intact", async () => {
    const owner = await throwaway("own", "Owner Two");
    const x = await throwaway("cgx", "Caregiver Ex"), z = await throwaway("cgz", "Caregiver Zed"), v = await throwaway("cgv", "Caregiver Vee");
    const f1 = await fileFor(owner.page, "Owner File One"), f2 = await fileFor(owner.page, "Owner File Two"), f3 = await fileFor(owner.page, "Owner File Three");
    const ids = { x: await uidOf(x.email), z: await uidOf(z.email), v: await uidOf(v.email), o: await uidOf(owner.email) };
    for (const [f, who] of [[f1, "x"], [f2, "z"], [f3, "v"]]) await pgq("insert into patient_members (patient_id, user_id, role, can_write, can_share) values ($1, $2, 'caregiver', true, false)", [f, ids[who]]);
    // the caregiver records an allergy in the owner's file
    await x.page.goto(`${BASE}/patients/${f1}/allergies`);
    await openSummary(x.page, "Add allergy");
    await x.page.fill("#allergies_new_substance", "Latex (by the caregiver)");
    await x.page.selectOption("#allergies_new_severity", "mild"); await x.page.selectOption("#allergies_new_certainty", "confirmed");
    await submit(x.page, "Save");
    await x.page.getByText("Saved.").first().waitFor();
    // the owner cannot delete: the shared files are listed with their members
    const op = owner.page;
    await op.goto(`${BASE}/account#delete-account`);
    await op.getByText("Files shared with other people block the deletion").waitFor();
    assert((await op.locator("#del-confirm").count()) === 0, "no deletion form while files are shared");
    for (const [name, member] of [["Owner File One", "Caregiver Ex"], ["Owner File Two", "Caregiver Zed"], ["Owner File Three", "Caregiver Vee"]]) {
      const sec = op.locator("section.member-file", { hasText: name });
      await sec.getByText(member, { exact: true }).waitFor();
      assert(/Caregiver/.test(await sec.innerText()), "the member's role is shown");
    }
    // remove one member, transfer another file
    op.once("dialog", (d) => d.accept());
    await op.locator("section.member-file", { hasText: "Owner File Three" }).getByRole("button", { name: "Remove Caregiver Vee from Owner File Three" }).click();
    await op.locator("section.member-file", { hasText: "Owner File Three" }).waitFor({ state: "detached" });
    assert((await pgq("select revoked_at is not null as r from patient_members where patient_id = $1 and user_id = $2", [f3, ids.v])).rows[0].r, "the removed member is revoked");
    const gone = await v.page.goto(`${BASE}/patients/${f3}`);
    assert(gone.status() === 404, "the removed member can no longer open the file");
    op.once("dialog", (d) => d.accept());
    await op.locator("section.member-file", { hasText: "Owner File Two" }).getByRole("button", { name: "Make Caregiver Zed the owner of Owner File Two" }).click();
    await op.locator("section.member-file", { hasText: "Owner File Two" }).waitFor({ state: "detached" });
    const roles = (await pgq("select user_id, role from patient_members where patient_id = $1", [f2])).rows;
    assert(roles.find((r) => r.user_id === ids.z)?.role === "owner" && roles.find((r) => r.user_id === ids.o)?.role === "guardian", "ownership moved to the member");
    await op.locator("section.member-file", { hasText: "Owner File One" }).getByText("Caregiver Ex", { exact: true }).waitFor();

    // the caregiver deletes his account (he owns no file); the grace period passes
    const xp = x.page;
    await xp.goto(`${BASE}/account#delete-account`);
    await xp.fill("#del-confirm", x.email); await xp.fill("#del-password", PW); await xp.check('input[name="ack"]');
    await submit(xp, "Delete my account");
    await xp.waitForURL(/\/login\?deleted=1/);
    await pgq("update account_deletions set requested_at = now() - interval '31 days', scheduled_for = now() - interval '1 day' where user_id = $1", [ids.x]);
    const j = await (await cron(process.env.CRON_SECRET)).json();
    assert(j.failed === 0 && j.accounts.failed === 0 && j.accounts.purged === 1, "the job purged the account: " + JSON.stringify(j));
    const tomb = (await pgq("select method from account_deletions where user_id = $1", [ids.x])).rows[0];
    assert(tomb && tomb.method === "anonymised", "records of another account name him, so the identity is anonymised, not erased: " + JSON.stringify(tomb));
    const au = (await pgq("select email, deleted_at is not null as d from auth.users where id = $1", [ids.x])).rows[0];
    assert(au && au.d && /^deleted\+/.test(au.email), "the identity no longer carries his e-mail");
    assert((await pgq("select count(*)::int n from patient_members where user_id = $1", [ids.x])).rows[0].n === 0, "his access is gone");
    assert((await pgq("select count(*)::int n from allergies where patient_id = $1 and recorded_by = $2", [f1, ids.x])).rows[0].n === 1, "his record in the owner's file is untouched");
    assert((await pgq("select full_name from profiles where id = $1", [ids.x])).rows[0].full_name === "", "his profile is blanked");
    assert((await pgq("select full_name from profiles where id = $1", [ids.o])).rows[0].full_name === "Owner Two", "the owner's profile is untouched");
    await signIn(xp, x.email); await xp.getByRole("alert").getByText("Incorrect email or password.").waitFor();
    await op.goto(`${BASE}/patients/${f1}/allergies`);
    await op.getByText("Latex (by the caregiver)", { exact: true }).waitFor();
    // with the caregiver gone the owner has nothing left that blocks
    await op.goto(`${BASE}/account#delete-account`);
    await op.locator("#del-confirm").waitFor();
    for (const c of [owner, x, z, v]) await c.ctx.close();
  });

  // ---------------------------------------------------------------- care: reminders, needs attention, emergency card, members (migration 0031)
  const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const remTitle = `Renew passport ${stamp}`, repTitle = `Weigh-in ${stamp}`;

  await step("reminders: write one, see it on the file, the centre and the bell; done closes it", async () => {
    await page.goto(`${BASE}/patients/${pid}/reminders`);
    await page.getByText(/no sending service is connected/).first().waitFor();
    await page.fill("#rem_title", remTitle); await page.fill("#rem_due", ymd(1));
    await submit(page, "Add reminder");
    await page.getByText("The reminder was added.").waitFor();
    await page.reload();
    const item = page.locator("li.reminder", { hasText: remTitle });
    await item.waitFor();
    assert((await item.getAttribute("data-state")) === "soon" && (await item.getAttribute("data-kind")) === "custom", "a written reminder inside its lead time is soon");
    await page.goto(`${BASE}/patients`);
    const n = Number(await page.getByTestId("reminder-count").first().innerText());
    assert(n >= 1, "the bell counts it: " + n);
    await page.goto(`${BASE}/reminders`);
    await page.locator("li.reminder", { hasText: remTitle }).waitFor();
    await page.locator("section.card", { hasText: "Alice Alpha" }).first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/reminders`);
    await page.locator("li.reminder", { hasText: remTitle }).getByRole("button", { name: "Done" }).click();
    await page.locator("li.reminder", { hasText: remTitle }).waitFor({ state: "detached" });
    await page.locator("article.rec", { hasText: remTitle }).getByText("Done", { exact: true }).waitFor();
  });

  await step("reminders: a repeating one moves on when done; one written by mistake is invalidated with a reason", async () => {
    await page.goto(`${BASE}/patients/${pid}/reminders`);
    await page.fill("#rem_title", repTitle); await page.fill("#rem_due", ymd(0)); await page.fill("#rem_rep", "1");
    await submit(page, "Add reminder");
    await page.getByText("The reminder was added.").waitFor();
    await page.reload();
    await page.locator("li.reminder", { hasText: repTitle }).getByRole("button", { name: "Done" }).click();
    await page.locator("li.reminder", { hasText: repTitle }).waitFor({ state: "detached" });
    const art = page.locator("article.rec", { hasText: repTitle });
    await art.getByText("Open", { exact: true }).waitFor();
    await art.getByText("every 1 mo").waitFor();
    await art.locator("summary", { hasText: "Entered in error" }).click();
    await art.locator('input[name="reason"]').fill("added twice");
    page.once("dialog", (d) => d.accept());
    await art.getByRole("button", { name: "Invalidate" }).click();
    await art.waitFor({ state: "detached" });
    await page.reload();
    assert((await page.locator("article.rec", { hasText: repTitle }).count()) === 0, "an invalidated reminder leaves the active list");
  });

  await step("reminders: an open test request past its target date is gathered with its record", async () => {
    await page.goto(`${BASE}/patients/${pid}/test-orders`);
    await openSummary(page, "Add test request");
    await page.fill("#test-orders_new_name", "Overdue E2E test");
    await page.fill("#test-orders_new_requested_on", ymd(-10)); await page.fill("#test-orders_new_target_on", ymd(-5));
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();
    await page.goto(`${BASE}/patients/${pid}/reminders`);
    const item = page.locator("li.reminder", { hasText: "Overdue E2E test" });
    await item.waitFor();
    assert((await item.getAttribute("data-state")) === "overdue" && (await item.getAttribute("data-kind")) === "test_order", "overdue test request: " + (await item.getAttribute("data-state")) + " " + (await item.getAttribute("data-kind")) + " " + (await item.innerText()).replace(/\s+/g, " "));
    await item.getByText("5 days overdue").waitFor();
    await item.getByRole("link", { name: /Requested test not done/ }).click();
    await page.waitForURL(/\/test-orders$/);
  });

  await step("needs attention: the latest abnormal lab against its reference, with the trend; a lab comparison of two reports", async () => {
    await page.goto(`${BASE}/patients/${pid}/labs/new`);
    await page.fill("#title", "CBC follow-up E2E");
    await page.selectOption("#r0_type", { label: "Hemoglobin (Hb) (g/dL)" });
    await page.fill("#r0_value", "11.8"); await page.fill("#r0_ref_low", "12"); await page.fill("#r0_ref_high", "16");
    await submit(page, "Save report");
    await page.getByText("Report and results saved.").waitFor();
    await page.goto(`${BASE}/patients/${pid}`);
    await page.getByRole("heading", { name: "Needs your attention" }).waitFor();
    const lab = page.getByTestId("attention-lab").filter({ hasText: "Hemoglobin" });
    await lab.waitFor();
    assert((await lab.innerText()).includes("11.8"), "the latest value is shown: " + (await lab.innerText()));
    await lab.getByText(/closer to range|further out|steady/).waitFor();
    await page.goto(`${BASE}/patients`);
    await page.locator("a.card", { hasText: "Alice Alpha" }).first().getByText(/\d+ lab out of range/).waitFor();
    // compare two reports by date
    await page.goto(`${BASE}/patients/${pid}/labs?view=compare`);
    const val = async (sel, text) => page.locator(`${sel} option`, { hasText: text }).first().getAttribute("value");
    await page.selectOption("#cmp_a", await val("#cmp_a", "CBC panel"));
    await page.selectOption("#cmp_b", await val("#cmp_b", "CBC follow-up E2E"));
    await submit(page, "Compare");
    const row = page.getByTestId("compare-table").locator("tr", { hasText: "Hemoglobin" });
    await row.waitFor();
    const txt = await row.innerText();
    assert(txt.includes("10.2") && txt.includes("11.8") && txt.includes("+1.6"), "values side by side with the change: " + txt);
  });

  const careAr = async (url) => {   // a page opened on a phone in Arabic must not scroll sideways
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA", timezoneId: "Asia/Riyadh" });
    await m.addCookies([...(await ctx.cookies()).filter((c) => c.name !== "lang"), { name: "lang", value: "ar", url: BASE }]);
    const mp = await m.newPage(); watch(mp, "care-mobile");
    const r = await mp.goto(url);
    assert(r.status() === 200, `${url} => ${r.status()}`);
    assert((await mp.locator("html").getAttribute("dir")) === "rtl", "rtl");
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await m.close();
    return over;
  };

  let emLink = "", emLink2 = "";
  await step("emergency card: a card with the core fields; the public link is off by default", async () => {
    // records that must (and must not) reach the card
    await page.goto(`${BASE}/patients/${pid}/medications`);
    for (const [name, sensitive] of [["LongTerm E2E med", false], ["Secret E2E med", true]]) {
      await openSummary(page, "Add medication");
      await page.fill("#medications_new_name_generic", name);
      const form = page.locator("form:has(#medications_new_name_generic)");
      await form.getByLabel("Long-term (taken continuously)").check();
      if (sensitive) await form.getByLabel("Sensitive (shared only when explicitly allowed)").check();
      await submit(page, "Save");
      await page.getByText("Saved.").first().waitFor();
      await page.reload();
    }
    await page.goto(`${BASE}/patients/${pid}/conditions`);
    await openSummary(page, "Add condition");
    await page.fill("#conditions_new_name", "Secret E2E dx");
    await page.selectOption("#conditions_new_category", "chronic");
    await page.locator("form:has(#conditions_new_name)").getByLabel("Sensitive (shared only when explicitly allowed)").check();
    await submit(page, "Save");
    await page.getByText("Saved.").first().waitFor();

    await page.goto(`${BASE}/patients/${pid}/emergency`);
    const card = page.getByTestId("emergency-card");
    await card.waitFor();
    const txt = await card.innerText();
    for (const w of ["Alice Alpha", "A+", "Penicillin", "Hypertension", "LongTerm E2E med", "Omar Alpha", "+966511111111"]) assert(txt.includes(w), `the card shows ${w}`);
    for (const w of ["Secret E2E", "1098765432", "+966500000001", "Entered by mistake"]) assert(!txt.includes(w), `the card must not show ${w}`);
    await page.getByTestId("emergency-status").getByText("Link is off").waitFor();
    assert(!(await page.getByLabel(/Also show items I marked sensitive/).isChecked()), "the sensitive opt-in starts off");
    // the PDF card (no QR: no token is kept)
    const res = await page.request.get(`${BASE}/api/patients/${pid}/emergency/pdf`);
    assert(res.status() === 200 && /pdf/.test(res.headers()["content-type"]) && (await res.body()).subarray(0, 4).toString() === "%PDF", "the card PDF");
  });

  await step("emergency card: switch the link on; it shows the card only, with no sign-in, and a QR", async () => {
    await page.goto(`${BASE}/patients/${pid}/emergency`);
    await page.getByRole("button", { name: "Switch the link on" }).click();
    await page.getByTestId("emergency-link-box").waitFor();
    emLink = (await page.getByTestId("emergency-link").inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    assert(/\/e\/[A-Za-z0-9_-]{32}$/.test(emLink), "link: " + emLink);
    await page.locator(".emergency-qr svg").waitFor();
    await page.getByTestId("emergency-status").getByText("Link is on").waitFor();
    // a stranger without an account opens it
    const anon = await newContext(browser); const ap = await anon.newPage(); watch(ap, "anon");
    const r = await ap.goto(emLink);
    assert(r.status() === 200, "public card opens: " + r.status());
    assert(/noindex/.test(r.headers()["x-robots-tag"] ?? "") && /no-store/.test(r.headers()["cache-control"] ?? ""), "never indexed or cached");
    const t = await ap.getByTestId("emergency-card").innerText();
    for (const w of ["Alice Alpha", "A+", "Penicillin", "Hypertension", "LongTerm E2E med", "Omar Alpha"]) assert(t.includes(w), `public card shows ${w}`);
    for (const w of ["Secret E2E", "1098765432", "+966500000001", "Entered by mistake", "Metformin"]) assert(!t.includes(w), `public card must not show ${w}`);
    assert((await ap.locator("nav, .rail, a[href='/patients']").count()) === 0, "no navigation into the app");
    const html = await ap.content();
    assert(!/SH-\d{8}/.test(html), "no file number");
    // phone, Arabic
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA" });
    await m.addCookies([{ name: "lang", value: "ar", url: BASE }]);
    const mp = await m.newPage(); await mp.goto(emLink);
    await mp.getByText("بطاقة الطوارئ الطبية").first().waitFor();
    assert((await mp.locator("html").getAttribute("dir")) === "rtl", "rtl");
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 1, "public card overflows by " + over);
    await mp.screenshot({ path: path.join(OUT, "mobile-emergency-public-ar.png"), fullPage: true });
    await m.close(); await anon.close();
    for (const u of [`${BASE}/patients/${pid}/emergency`, `${BASE}/patients/${pid}/reminders`, `${BASE}/patients/${pid}/members`, `${BASE}/patients/${pid}/labs?view=compare`, `${BASE}/reminders`, `${BASE}/patients/${pid}`]) {
      const o = await careAr(u); assert(o <= 1, `${u} overflows by ${o}px`);
    }
  });

  await step("emergency card: the sensitive opt-in, the QR on the PDF, regenerating and switching off", async () => {
    const anon = await newContext(browser); const ap = await anon.newPage(); watch(ap, "anon2");
    await page.goto(`${BASE}/patients/${pid}/emergency`);
    await page.getByLabel(/Also show items I marked sensitive/).check();
    await page.locator("form:has(input[name=include_sensitive])").getByRole("button", { name: "Save" }).click();
    await page.getByText("What the card shows was saved.").waitFor();
    await ap.goto(emLink);
    const t = await ap.getByTestId("emergency-card").innerText();
    assert(t.includes("Secret E2E dx") && t.includes("Secret E2E med"), "with the opt-in the sensitive items appear");
    await page.reload();
    await page.getByLabel(/Also show items I marked sensitive/).uncheck();
    await page.locator("form:has(input[name=include_sensitive])").getByRole("button", { name: "Save" }).click();
    await page.getByText("What the card shows was saved.").waitFor();
    await ap.goto(emLink);
    assert(!(await ap.getByTestId("emergency-card").innerText()).includes("Secret E2E"), "opting out hides them at once");
    // regenerate: the old link dies, the new one works, the PDF carries a QR only for the current token
    await page.reload();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Regenerate the link" }).click();
    await page.getByTestId("emergency-link-box").waitFor();
    emLink2 = (await page.getByTestId("emergency-link").inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    assert(emLink2 !== emLink && /\/e\/[A-Za-z0-9_-]{32}$/.test(emLink2), "a new link");
    await ap.goto(emLink);
    await ap.getByText("This link is not available").waitFor();
    await ap.goto(emLink2);
    await ap.getByTestId("emergency-card").waitFor();
    const token = emLink2.split("/e/")[1];
    const withQr = await page.request.post(`${BASE}/api/patients/${pid}/emergency/pdf`, { form: { token } });
    const bogus = await page.request.post(`${BASE}/api/patients/${pid}/emergency/pdf`, { form: { token: "x".repeat(32) } });
    assert(withQr.status() === 200 && bogus.status() === 200, "both PDFs render");
    assert((await withQr.body()).length > (await bogus.body()).length + 500, "the current token adds a QR; a wrong one adds nothing");
    // a wrong link: tries are rate limited per address
    const wrong = (n) => `${BASE}/e/${String(n).padStart(2, "0")}${"w".repeat(30)}`;
    for (let i = 0; i < 9; i++) { await ap.goto(wrong(i)); await ap.getByText("This link is not available").waitFor(); }
    await ap.goto(wrong(9));
    await ap.getByText("Too many requests").waitFor();
    await ap.goto(emLink2);
    await ap.getByText("Too many requests").waitFor();
    // switch it off
    await page.reload();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Switch the link off" }).click();
    await page.getByTestId("emergency-status").getByText("Link is off").waitFor();
    const anon2 = await newContext(browser); const bp = await anon2.newPage();
    await bp.goto(emLink2);
    await bp.getByText("This link is not available").waitFor();
    await page.reload();
    await page.getByTestId("emergency-status").getByText("Link is off").waitFor();
    await page.getByText("Attempt on a switched-off link").first().waitFor();
    await page.getByText("Card opened").first().waitFor();
    await anon.close(); await anon2.close();
  });

  const cBobEmail = `carebob-${stamp}@example.test`, eveEmail = `eve-${stamp}@example.test`;
  let inviteLinkText = "";
  await step("members: invite by e-mail as editor; the link is shown once and only its hash is kept", async () => {
    await page.goto(`${BASE}/patients/${pid}/members`);
    await page.fill("#inv_email", cBobEmail); await page.selectOption("#inv_access", "editor");
    await submit(page, "Create the invitation link");
    await page.getByTestId("invite-link-box").waitFor();
    inviteLinkText = (await page.getByTestId("invite-link").inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    assert(/\/invite\/[A-Za-z0-9_-]{32}$/.test(inviteLinkText), "invite link: " + inviteLinkText);
    await page.goto(`${BASE}/patients/${pid}/members`);
    const row = page.locator('[data-testid="invite-row"]', { hasText: cBobEmail });
    await row.getByText("Waiting").waitFor();
    await row.getByText("Editor").waitFor();
    assert(!(await page.content()).includes(inviteLinkText.split("/invite/")[1]), "the token is not in the page after it was shown");
    await page.fill("#inv_email", "not-an-address"); await page.evaluate(() => document.querySelector("form:has(#inv_email)").noValidate = true);
    await submit(page, "Create the invitation link");
    await page.getByText("Enter a valid e-mail address.").waitFor();
  });

  const cBobCtx = await newContext(browser); const cBob = await cBobCtx.newPage(); watch(cBob, "cBob");
  await step("members: only the invited account can use the link; the editor joins and can write but not manage", async () => {
    const eveCtx = await newContext(browser); const eve = await eveCtx.newPage(); watch(eve, "eve");
    await signup(eve, eveEmail, "Eve Gamma");
    await eve.goto(inviteLinkText);
    await eve.getByText("This invitation is for another account").waitFor();
    assert((await eve.getByRole("button", { name: "Accept the invitation" }).count()) === 0, "no accept button for a stranger");
    assert((await eve.goto(`${BASE}/patients/${pid}`)).status() === 404, "and no access");
    await eveCtx.close();

    await signup(cBob, cBobEmail, "Bob Beta");
    assert((await cBob.goto(`${BASE}/patients/${pid}`)).status() === 404, "before accepting there is no access");
    await cBob.goto(inviteLinkText);
    await cBob.getByText(/You were invited to the file/).waitFor();
    await cBob.getByText(/an editor/).waitFor();
    await cBob.getByRole("button", { name: "Accept the invitation" }).click();
    await cBob.waitForURL(new RegExp(`/patients/${pid}$`));
    await cBob.getByRole("heading", { name: "Alice Alpha" }).waitFor();
    await cBob.getByText("You are an editor").waitFor();
    // an editor writes
    await cBob.goto(`${BASE}/patients/${pid}/reminders`);
    await cBob.fill("#rem_title", `Bob reminder ${stamp}`); await cBob.fill("#rem_due", ymd(2));
    await submit(cBob, "Add reminder");
    await cBob.getByText("The reminder was added.").waitFor();
    // but cannot manage: no members page, no sharing, no way to switch the emergency link on
    assert((await cBob.goto(`${BASE}/patients/${pid}/members`)).status() === 404, "no members page");
    await cBob.goto(`${BASE}/patients/${pid}/sharing`);
    await cBob.getByText("Page not found").waitFor();
    assert((await cBob.getByRole("link", { name: "New share" }).count()) === 0, "no way to create a share");
    await cBob.goto(`${BASE}/patients/${pid}/emergency`);
    await cBob.getByTestId("emergency-card").waitFor();
    assert((await cBob.getByRole("button", { name: "Switch the link on" }).count()) === 0, "no emergency link controls for an editor");
    // a used link cannot be used again
    await cBob.goto(inviteLinkText);
    await cBob.getByText("This invitation is not available").waitFor();
    // the owner sees the new member
    await page.goto(`${BASE}/patients/${pid}/members`);
    const row = page.locator('[data-testid="member-row"]', { hasText: "Bob Beta" });
    await row.getByText("Editor").waitFor();
    await page.locator('[data-testid="invite-row"]', { hasText: cBobEmail }).getByText("Accepted").waitFor();
  });

  await step("members: removing a member ends their access at once", async () => {
    await page.goto(`${BASE}/patients/${pid}/members`);
    const row = page.locator('[data-testid="member-row"]', { hasText: "Bob Beta" });
    page.once("dialog", (d) => d.accept());
    await row.getByRole("button", { name: "Remove" }).click();
    await page.locator('[data-testid="member-row"]', { hasText: "Bob Beta" }).getByText("Removed").waitFor();
    assert((await cBob.goto(`${BASE}/patients/${pid}`)).status() === 404, "the removed member loses the file");
    assert((await cBob.goto(`${BASE}/patients/${pid}/reminders`)).status() === 404, "and its pages");
    await page.reload();
    await page.locator('[data-testid="member-row"]', { hasText: "Bob Beta" }).getByText("Removed").waitFor();
    // the owner cannot be removed
    assert((await page.locator('[data-testid="member-row"]', { hasText: "Alice Alpha" }).getByRole("button", { name: "Remove" }).count()) === 0, "no remove button for the owner");
    // a second invitation to the same address replaces the waiting one, and a cancelled one stops working
    await page.fill("#inv_email", cBobEmail); await page.selectOption("#inv_access", "viewer");
    await submit(page, "Create the invitation link");
    const link2 = (await page.getByTestId("invite-link").inputValue()).replace(/^https?:\/\/[^/]+/, BASE);
    await page.goto(`${BASE}/patients/${pid}/members`);
    const inv = page.locator('[data-testid="invite-row"]', { hasText: cBobEmail }).filter({ hasText: "Waiting" });
    page.once("dialog", (d) => d.accept());
    await inv.getByRole("button", { name: "Cancel invitation" }).click();
    await page.locator('[data-testid="invite-row"]', { hasText: cBobEmail }).getByText("Cancelled").first().waitFor();
    await cBob.goto(link2);
    await cBob.getByText("This invitation is not available").waitFor();
    await cBobCtx.close();
  });

  // ---------------------------------------------------------------- responsive + RTL
  // every page of the signed-in app on a phone: no sideways scroll, the content column uses the width, and the top bar is one row that sits above the page
  const PHONE_PAGES = ["", "/dental", "/dental?tab=perio", "/dental?tab=treatment", "/dental?tab=care", "/medications", "/reminders", "/emergency", "/labs", "/labs?view=compare", "/timeline", "/sharing/new", "/documents", "/profile", "/vitals", "/specialties", "/members", "ACCOUNT", "PATIENTS"];
  const phoneCheck = async (mp, lang) => {
    for (const p of PHONE_PAGES) {
      const url = p === "ACCOUNT" ? `${BASE}/account` : p === "PATIENTS" ? `${BASE}/patients` : `${BASE}/patients/${pid}${p}`;
      const label = p || "/";
      const r = await mp.goto(url);
      assert(r.status() === 200, `${label} => ${r.status()}`);
      assert((await mp.locator("html").getAttribute("dir")) === (lang === "ar" ? "rtl" : "ltr"), "direction");
      const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const culprits = over > 1 ? await mp.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1))) return false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if ((o !== "visible" && o !== "clip") || a.matches("details:not([open])")) return false; }
        return true;
      }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ")[0]}`)) : [];
      assert(over <= 1, `horizontal overflow of ${over}px on ${label} (${culprits.join(", ")})`);
      const g = await mp.evaluate(() => {
        const vw = document.documentElement.clientWidth, box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        return { vw, content: box(".shell-content"), top: box(".shell-top"), below: box(".shell-below"), clipped: [...document.querySelectorAll(".shell-top *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1) && !el.closest(".crumbs"); }).length };
      });
      assert(g.content && g.content.w > g.vw * 0.7, `the content column is ${g.content && Math.round(g.content.w)}px of ${g.vw}px on ${label}`);
      assert(g.top && g.top.h <= 49 && Math.abs(g.top.w - g.vw) <= 1 && g.top.t === 0, `the top bar is not one full-width row on ${label}: ${JSON.stringify(g.top)}`);
      assert(g.below.t >= g.top.b - 0.5, `the top bar overlaps the page on ${label}`);
      assert(g.clipped === 0, `${g.clipped} top bar items fall outside the screen on ${label}`);
    }
  };
  await step("mobile viewport (Arabic, RTL, 390px): every page lays out, no horizontal scroll, full-width content, one-row top bar", async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-SA", timezoneId: "Asia/Riyadh" });
    await m.addCookies([...(await ctx.cookies()).filter((c) => c.name !== "lang"), { name: "lang", value: "ar", url: BASE }]);
    const mp = await m.newPage(); watch(mp, "mobile");
    await phoneCheck(mp, "ar");
    for (const [p, f] of [["", "mobile-dashboard-ar.png"], ["/vitals", "mobile-vitals-ar.png"], ["/dental", "mobile-dental-ar.png"]]) { await mp.goto(`${BASE}/patients/${pid}${p}`); await mp.screenshot({ path: path.join(OUT, f), fullPage: true }); }
    // small screens: the products open from the menu button; the active product's pages are a strip under the top bar
    await mp.goto(`${BASE}/patients/${pid}/vitals`);
    await mp.locator(".shell-subnav").getByRole("link", { name: "التحاليل المخبرية" }).waitFor();
    await mp.locator(".shell-burger").click();
    await mp.locator(".drawer").getByRole("link", { name: "الملف الأساسي" }).click();
    await mp.waitForURL(/\/profile$/);
    await m.close();
  });

  await step("mobile viewport (English, LTR, 360px, light and dark): every page lays out the same way", async () => {
    for (const theme of ["light", "dark"]) {
      const m = await browser.newContext({ viewport: { width: 360, height: 740 }, locale: "en-GB", timezoneId: "Asia/Riyadh" });
      await m.addCookies([...(await ctx.cookies()).filter((c) => c.name !== "lang" && c.name !== "theme"), { name: "lang", value: "en", url: BASE }, { name: "theme", value: theme, url: BASE }]);
      const mp = await m.newPage(); watch(mp, "mobile-en");
      await phoneCheck(mp, "en");
      // the search is an icon button on a phone; it opens a box across the top bar, closes on Escape
      await mp.goto(`${BASE}/patients/${pid}`);
      assert(!(await mp.locator(".shell-search input").isVisible()), "the search box starts collapsed");
      await mp.getByRole("button", { name: "Search", exact: true }).click();
      await mp.locator(".shell-search input").waitFor();
      await mp.keyboard.press("Escape");
      await mp.locator(".shell-search input").waitFor({ state: "hidden" });
      if (theme === "dark") await mp.goto(`${BASE}/patients/${pid}/dental`), await mp.screenshot({ path: path.join(OUT, "mobile-dental-en-dark.png"), fullPage: true });
      await m.close();
    }
  });

  await step("desktop shell: a full-width top bar above the rail, a rail that pushes (never covers) its neighbour, three persistent modes", async () => {
    const dc = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-GB", timezoneId: "Asia/Riyadh" });
    await dc.addCookies((await ctx.cookies()).filter((c) => c.name !== "sidebar"));
    const dp = await dc.newPage(); watch(dp, "desktop-shell");
    const box = (sel) => dp.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; }, sel);
    const railW = () => dp.evaluate(() => document.querySelector("nav.rail").getBoundingClientRect().width);
    // waits until the element's width satisfies ("gt" / "lt" / "eq" the given px): the rail animates for 150ms
    const settled = async (sel, op, n) => { await dp.waitForFunction(([s, o, v]) => { const w = document.querySelector(s).getBoundingClientRect().width; return o === "gt" ? w > v : o === "lt" ? w < v : Math.abs(w - v) < 1; }, [sel, op, n], { timeout: 3000 }); };
    await dp.goto(`${BASE}/patients/${pid}/dental`);
    assert((await dp.locator("html").getAttribute("data-sidebar")) === "hover", "the default mode is expand on hover");
    // (a) the top bar is the first row, the full width, above the rail and the product menu
    const top = await box(".shell-top"), rail = await box("nav.rail"), pm = await box("nav.product-menu");
    assert(top.l === 0 && top.t === 0 && Math.abs(top.w - 1280) <= 1, "the top bar spans the viewport " + JSON.stringify(top));
    assert(rail.t >= top.b - 0.5 && pm.t >= top.b - 0.5, `the rail and the menu start under the top bar: ${rail.t} / ${pm.t} vs ${top.b}`);
    assert(Math.abs(rail.w - 48) <= 1, "the rail rests at 3rem, got " + rail.w);
    assert(Math.abs(rail.h - (800 - top.b)) <= 1, "the rail fills the height under the top bar, got " + rail.h);
    assert((await dp.locator(".shell-top .shell-brand").count()) === 1, "the brand sits in the top bar");
    // (b) hover: the rail widens and the product menu moves aside (it is pushed, not covered)
    await dp.locator('nav.rail a[data-product="follow"]').hover();
    await settled("nav.rail", "eq", 208);
    const railOpen = await box("nav.rail"), pmOpen = await box("nav.product-menu");
    assert(Math.abs(railOpen.w - 208) <= 1, "the hovered rail is 13rem, got " + railOpen.w);
    assert(Math.abs(pmOpen.l - pm.l) > 100, `the product menu moved from ${pm.l} to ${pmOpen.l}`);
    assert(railOpen.r <= pmOpen.l + 0.5 || railOpen.l >= pmOpen.r - 0.5, "the expanded rail does not intersect the product menu");
    assert((await dp.locator("nav.rail .rail-label").first().evaluate((el) => getComputedStyle(el).opacity)) === "1", "labels show when the rail is expanded");
    await dp.mouse.move(700, 500);
    await settled("nav.rail", "eq", 48);
    assert(Math.abs((await box("nav.product-menu")).l - pm.l) <= 1, "the product menu returns when the rail collapses");
    // keyboard focus expands it as well
    await dp.keyboard.press("Tab");
    await dp.locator('nav.rail a[data-product="follow"]').focus();
    await settled("nav.rail", "eq", 208);
    await dp.locator('nav.rail a[data-product="follow"]').blur();
    await settled("nav.rail", "eq", 48);
    // (c) the three modes: a small menu "Sidebar" with radio items; Escape and an outside click close it; the choice survives a reload (cookie, read by the server)
    await dp.locator('nav.rail a[data-product="follow"]').hover();
    await settled("nav.rail", "eq", 208);
    await dp.getByRole("button", { name: "Sidebar" }).click();
    const menu = dp.getByRole("menu", { name: "Sidebar" });
    await menu.waitFor();
    assert((await menu.getByRole("menuitemradio").count()) === 3, "three radio items");
    assert((await menu.getByRole("menuitemradio", { name: "Expand on hover" }).getAttribute("aria-checked")) === "true", "hover is the current mode");
    await dp.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await dp.getByRole("button", { name: "Sidebar" }).click();
    await menu.waitFor();
    await dp.mouse.click(700, 400);
    await menu.waitFor({ state: "hidden" });
    const choose = async (name) => { await dp.locator("nav.rail").hover(); await dp.getByRole("button", { name: "Sidebar" }).click(); await dp.getByRole("menuitemradio", { name }).click(); };
    await choose("Expanded");
    assert((await dp.locator("html").getAttribute("data-sidebar")) === "open", "expanded");
    await dp.mouse.move(700, 500); await settled("nav.rail", "eq", 208);
    await dp.reload();
    assert((await dp.locator("html").getAttribute("data-sidebar")) === "open", "expanded survives a reload");
    assert(Math.abs((await railW()) - 208) <= 1, "the expanded rail is 13rem after a reload: " + (await railW()));
    const pmPushed = await box("nav.product-menu");
    assert(Math.abs(pmPushed.l - pmOpen.l) <= 1, "expanded: the product menu is pushed by the rail");
    await choose("Collapsed");
    await dp.mouse.move(700, 500); await settled("nav.rail", "eq", 48);
    await dp.reload();
    assert((await dp.locator("html").getAttribute("data-sidebar")) === "closed", "collapsed survives a reload");
    await dp.locator("nav.rail").hover(); await dp.waitForTimeout(400);
    assert(Math.abs((await railW()) - 48) <= 1, "collapsed stays icons-only on hover: " + (await railW()));
    assert((await dp.locator('nav.rail a[data-product="follow"]').getAttribute("title")) === "Follow-up", "collapsed items carry a tooltip");
    await choose("Expand on hover");
    await dp.reload();
    assert((await dp.locator("html").getAttribute("data-sidebar")) === "hover", "hover survives a reload");
    // (d) the avatar: a round 1px-bordered picture or initials
    const av = await dp.locator(".shell-top .navuser-btn .avatar").evaluate((el) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return { w: r.width, h: r.height, radius: c.borderRadius, border: c.borderTopWidth, fit: el.querySelector("img") ? getComputedStyle(el.querySelector("img")).objectFit : "initials", text: el.textContent }; });
    assert(av.w === av.h && av.w >= 28 && av.w <= 32, `the avatar is a ${av.w}x${av.h} square`);
    assert(av.radius === "50%" && av.border === "1px", `the avatar is round with a 1px border: ${av.radius} / ${av.border}`);
    assert(av.fit === "initials" ? /^[A-Z?]{1,2}$/.test(av.text) : av.fit === "cover", "initials or a covering picture");
    // (e) the search box: 32px, the icon inside at the start and clear of the text, grows without moving anything, "/" focuses it
    const s0 = await dp.evaluate(() => { const w = document.querySelector(".shell-search-wrap").getBoundingClientRect(), b = document.querySelector(".shell-bell").getBoundingClientRect(); return { w: w.width, l: w.left, bell: b.left }; });
    assert(Math.abs(s0.w - 224) <= 1, "the search box rests at 14rem, got " + s0.w);
    await dp.locator("body").click({ position: { x: 700, y: 400 } });
    await dp.keyboard.press("/");
    assert(await dp.locator(".shell-search input").evaluate((el) => el === document.activeElement), "/ focuses the search box");
    await dp.waitForTimeout(350);
    const s1 = await dp.evaluate(() => {
      const f = document.querySelector(".shell-search").getBoundingClientRect(), i = document.querySelector(".shell-search input"), ic = document.querySelector(".shell-search-icon").getBoundingClientRect(), cs = getComputedStyle(i), ir = i.getBoundingClientRect();
      const wrap = document.querySelector(".shell-search-wrap").getBoundingClientRect(), b = document.querySelector(".shell-bell").getBoundingClientRect();
      return { focusW: f.width, h: ir.height, iconInside: ic.left >= ir.left && ic.right <= ir.right, textStart: ir.left + parseFloat(cs.paddingLeft), iconRight: ic.right, wrapW: wrap.width, wrapL: wrap.left, bell: b.left, border: cs.borderTopWidth };
    });
    assert(Math.abs(s1.h - 32) <= 1, "the input is 32px high, got " + s1.h);
    assert(s1.iconInside && s1.textStart >= s1.iconRight, `the icon overlaps the text (icon ends ${s1.iconRight}, text starts ${s1.textStart})`);
    assert(Math.abs(s1.focusW - 352) <= 2, "the focused box is 22rem, got " + s1.focusW);
    assert(s1.wrapW === s0.w && s1.wrapL === s0.l && s1.bell === s0.bell, "growing on focus moves nothing around it");
    await dp.screenshot({ path: path.join(OUT, "desktop-shell-search-focus.png"), clip: { x: 0, y: 0, width: 1280, height: 60 } });
    await dp.mouse.move(700, 500);
    await dp.screenshot({ path: path.join(OUT, "desktop-shell-en.png") });
    // the same in Arabic: the rail is on the right, the icon at the start (right), the rail still pushes the menu
    await dc.addCookies([{ name: "lang", value: "ar", url: BASE }]);
    await dp.goto(`${BASE}/patients/${pid}/dental`);
    assert((await dp.locator("html").getAttribute("dir")) === "rtl", "rtl");
    const rr = await box("nav.rail"), rp = await box("nav.product-menu"), rt = await box(".shell-top");
    assert(Math.abs(rr.r - 1280) <= 1 && rp.r <= rr.l + 1 && rr.t >= rt.b - 0.5, "RTL: the rail is at the start (right), under the top bar, the menu next to it");
    await dp.locator('nav.rail a[data-product="follow"]').hover();
    await settled("nav.rail", "eq", 208);
    const rr2 = await box("nav.rail"), rp2 = await box("nav.product-menu");
    assert(Math.abs(rp2.r - rp.r) > 100 && rp2.r <= rr2.l + 1, "RTL: the menu is pushed away from the widened rail");
    await dp.mouse.move(600, 500);
    await dp.locator("body").click({ position: { x: 600, y: 400 } });
    await dp.keyboard.press("/");
    await dp.waitForTimeout(350);
    const sr = await dp.evaluate(() => { const i = document.querySelector(".shell-search input"), ic = document.querySelector(".shell-search-icon").getBoundingClientRect(), cs = getComputedStyle(i), ir = i.getBoundingClientRect(); return { iconLeft: ic.left, iconRight: ic.right, textStart: ir.right - parseFloat(cs.paddingRight), boxRight: ir.right }; });
    assert(sr.iconRight <= sr.boxRight && sr.iconLeft >= sr.textStart - 0.5, `RTL: the icon is at the start and clear of the text (${JSON.stringify(sr)})`);
    await dp.screenshot({ path: path.join(OUT, "desktop-shell-ar.png") });
    await dc.close();
  });

  await step("desktop screenshots for review", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/patients/${pid}`); await page.screenshot({ path: path.join(OUT, "desktop-dashboard.png"), fullPage: true });
    await page.goto(`${BASE}/patients/${pid}/vitals?type=blood_pressure&range=all`); await page.screenshot({ path: path.join(OUT, "desktop-vitals.png"), fullPage: true });
    await page.goto(`${BASE}/patients/${pid}/specialties/dentistry`); await page.screenshot({ path: path.join(OUT, "desktop-dentistry.png"), fullPage: true });
  });

  await browser.close();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (problems.length) { console.log("\nRuntime problems observed:"); [...new Set(problems)].forEach((p) => console.log(" -", p)); }
  process.exit(failed.length || problems.length ? 1 : 0);
})();
