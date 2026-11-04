// 弓道帳（チーム版）— 画面と処理
// 構成：ログイン（メールリンク）→ プロフィール → チーム所属 → ホーム／記録／チーム
import {
  auth,
  sendLoginLink,
  isEmailLink,
  completeEmailLink,
  watchAuth,
  logout,
  getUserProfile,
  saveUserProfile,
  createTeam,
  findTeamByInviteCode,
  getTeam,
  listTeamMembers,
  listPracticesByUser,
  listPracticesByTeam,
  savePractice,
  removePractice
} from "./firebase.js";

// ---------------- 状態 ----------------
const state = {
  user: null,          // Firebase Auth のユーザー
  profile: null,       // users/{uid}
  team: null,          // teams/{teamId}
  members: [],         // 同じチームの users
  myPractices: [],     // 自分の practices（日付の新しい順）
  teamPractices: [],   // チーム全員の practices
  homeRange: "total",  // today | month | total
  teamRange: "month",  // month | total
  detailUid: null      // メンバー詳細で表示中の uid
};

// 記録編集中の内容（1日分）
// work[type].shots: true=○ / false=×、yasho: {x,y} | null（shots と同じ並び）
const editor = {
  practiceId: null,
  date: todayStr(),
  mode: "tachi",
  memo: "",
  work: {
    tachi: { shots: [], yasho: [] },
    shakomi: { shots: [], yasho: [] }
  }
};

const GROUP_SIZE = { tachi: 4, shakomi: 2 };
const TYPE_LABEL = { tachi: "立", shakomi: "射込み" };

// ---------------- 小物 ----------------
const $ = (id) => document.getElementById(id);

function todayStr() {
  return dateToStr(new Date());
}
function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function monthStr(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return dateToStr(d).slice(0, 7);
}
function inRange(dateStr, range) {
  if (range === "total") return true;
  if (range === "today") return dateStr === todayStr();
  if (range === "month") return dateStr.slice(0, 7) === monthStr(0);
  if (range === "lastMonth") return dateStr.slice(0, 7) === monthStr(-1);
  return true;
}
function rateText(shots, hits) {
  if (!shots) return "―";
  return Math.round((hits / shots) * 100) + "%";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------------- 集計 ----------------
// practice 1件分の集計
function practiceStats(p) {
  const st = { shots: 0, hits: 0, tachi: { shots: 0, hits: 0 }, shakomi: { shots: 0, hits: 0 } };
  for (const e of p.entries || []) {
    const t = st[e.type];
    if (!t) continue;
    for (const s of e.shots || []) {
      t.shots++; st.shots++;
      if (s) { t.hits++; st.hits++; }
    }
  }
  return st;
}
function sumStats(list) {
  const total = { shots: 0, hits: 0, tachi: { shots: 0, hits: 0 }, shakomi: { shots: 0, hits: 0 } };
  for (const p of list) {
    const st = practiceStats(p);
    total.shots += st.shots; total.hits += st.hits;
    total.tachi.shots += st.tachi.shots; total.tachi.hits += st.tachi.hits;
    total.shakomi.shots += st.shakomi.shots; total.shakomi.hits += st.shakomi.hits;
  }
  return total;
}
// ○×をグループ（立=4、射込み=2）に分けた文字列リスト
function groupLines(p) {
  const lines = [];
  for (const e of p.entries || []) {
    const size = GROUP_SIZE[e.type] || 4;
    const shots = e.shots || [];
    for (let i = 0; i < shots.length; i += size) {
      const part = shots.slice(i, i + size);
      lines.push({
        label: `${TYPE_LABEL[e.type] || e.type} ${Math.floor(i / size) + 1}`,
        marks: part.map((s) => (s ? "○" : "×")).join(""),
        partial: part.length < size
      });
    }
  }
  return lines;
}
function marksHtml(marks) {
  return [...marks].map((m) =>
    m === "○" ? '<span class="shot-o">○</span>' : '<span class="shot-x">×</span>'
  ).join("");
}

// ---------------- 的グラフ（SVG） ----------------
// 的モチーフの同心円＋朱色の弧で的中率を表す
function targetGraphSvg(shots, hits) {
  const rate = shots ? hits / shots : 0;
  const C = 2 * Math.PI * 52;
  const arc = shots ? (C * rate).toFixed(1) : "0";
  const center = shots ? Math.round(rate * 100) + "%" : "―";
  return `
  <svg viewBox="0 0 128 128" role="img" aria-label="的中率 ${center}">
    <circle cx="64" cy="64" r="60" fill="#fffdf7" stroke="#2b2b28" stroke-width="2"/>
    <circle cx="64" cy="64" r="46" fill="none" stroke="#2b2b28" stroke-width="7"/>
    <circle cx="64" cy="64" r="32" fill="#fffdf7" stroke="#2b2b28" stroke-width="1.5"/>
    <circle cx="64" cy="64" r="52" fill="none" stroke="#c73e2c" stroke-width="5"
      stroke-dasharray="${arc} ${C.toFixed(1)}" transform="rotate(-90 64 64)" stroke-linecap="round"/>
    <circle cx="64" cy="64" r="7" fill="#c73e2c"/>
    <text x="64" y="97" text-anchor="middle" font-size="17" font-weight="700" fill="#2b2b28">${center}</text>
  </svg>`;
}

// 矢所の的（入力用・表示用で共用）。points: [{x,y}]（中心=0、右・下が正、-1〜1）
function targetPadSvg(points, clickable) {
  const dots = (points || []).map((pt) => {
    const cx = (110 + pt.x * 100).toFixed(1);
    const cy = (110 + pt.y * 100).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="#c73e2c" fill-opacity="0.75" stroke="#fff" stroke-width="1.5"/>`;
  }).join("");
  return `
  <svg viewBox="0 0 220 220" ${clickable ? 'id="yasho-svg"' : ""} role="img" aria-label="的">
    <circle cx="110" cy="110" r="104" fill="#fffdf7" stroke="#2b2b28" stroke-width="2.5"/>
    <circle cx="110" cy="110" r="76" fill="none" stroke="#2b2b28" stroke-width="12"/>
    <circle cx="110" cy="110" r="46" fill="#fffdf7" stroke="#2b2b28" stroke-width="2"/>
    <circle cx="110" cy="110" r="10" fill="#2b2b28"/>
    ${dots}
  </svg>`;
}

// ---------------- 画面の切り替え ----------------
function showView(id) {
  for (const v of ["view-loading", "view-login", "view-profile", "view-team-setup", "view-main"]) {
    $(v).hidden = v !== id;
  }
}

async function route() {
  if (!state.user) { showView("view-login"); return; }
  if (!state.profile) { showView("view-profile"); return; }
  if (!state.profile.teamId) {
    $("setup-hello").textContent = state.profile.name || "";
    showView("view-team-setup");
    return;
  }
  showView("view-main");
  $("header-sub").textContent =
    `${state.team ? state.team.name : ""} ／ ${state.profile.name}${state.profile.grade ? "（" + state.profile.grade + "）" : ""}${state.profile.role === "leader" ? "・リーダー" : ""}`;
  await refreshData();
  renderHome();
  // 記録タブの日付欄が未設定なら、今日の記録（あれば）を読み込んでおく
  if (!$("record-date").value) {
    const todayPractice = state.myPractices.find((p) => p.date === todayStr());
    if (todayPractice) loadIntoEditor(todayPractice);
    else $("record-date").value = editor.date;
  }
  renderEditor();
  renderTeam();
}

async function refreshData() {
  if (!state.user || !state.profile?.teamId) return;
  const [mine, teamAll, members, team] = await Promise.all([
    listPracticesByUser(state.user.uid),
    listPracticesByTeam(state.profile.teamId),
    listTeamMembers(state.profile.teamId),
    getTeam(state.profile.teamId)
  ]);
  state.myPractices = mine;
  state.teamPractices = teamAll;
  state.members = members;
  state.team = team;
}

// ログイン後に users / teams を読み込む
async function loadProfileAndTeam() {
  state.profile = await getUserProfile(state.user.uid);
  state.team = state.profile?.teamId ? await getTeam(state.profile.teamId) : null;
}

// ---------------- 起動 ----------------
async function boot() {
  // メールリンクから戻ってきた場合、先にログインを完了させる
  if (isEmailLink(window.location.href)) {
    try {
      await completeEmailLink(window.location.href, () =>
        window.prompt("確認のため、リンクを送ったメールアドレスを入力してください")
      );
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {
      console.error(e);
      $("login-message").textContent = "ログインに失敗しました。もう一度リンクを送ってください。";
      showView("view-login");
      return;
    }
  }
  watchAuth(async (user) => {
    state.user = user;
    if (user) {
      try {
        await loadProfileAndTeam();
      } catch (e) {
        console.error(e);
      }
    } else {
      state.profile = null;
      state.team = null;
    }
    await route();
  });
}

// ---------------- ログイン ----------------
$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("login-email").value.trim();
  const msg = $("login-message");
  $("login-send").disabled = true;
  try {
    await sendLoginLink(email);
    msg.textContent = "リンクを送りました。メールを確認して、リンクを開いてください。";
    msg.classList.add("ok");
  } catch (e) {
    console.error(e);
    msg.textContent = "送信に失敗しました。アドレスを確認してもう一度お試しください。";
    msg.classList.remove("ok");
  } finally {
    $("login-send").disabled = false;
  }
});

// ---------------- プロフィール ----------------
$("profile-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("profile-name").value.trim();
  const grade = $("profile-grade").value.trim();
  if (!name) return;
  try {
    await saveUserProfile(state.user.uid, {
      name,
      grade: grade || null,
      teamId: state.profile?.teamId ?? null,
      role: state.profile?.role ?? null,
      email: state.user.email || null
    });
    await loadProfileAndTeam();
    await route();
  } catch (e) {
    console.error(e);
    $("profile-message").textContent = "保存に失敗しました。通信環境を確認してください。";
  }
});

// ---------------- チーム作成・参加 ----------------
$("team-create-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("team-name").value.trim();
  if (!name) return;
  const msg = $("setup-message");
  try {
    const team = await createTeam(name, state.user.uid);
    await saveUserProfile(state.user.uid, { teamId: team.id, role: "leader" });
    await loadProfileAndTeam();
    msg.textContent = "";
    await route();
  } catch (e) {
    console.error(e);
    msg.textContent = "チームの作成に失敗しました。通信環境を確認してください。";
  }
});

$("team-join-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const code = $("team-invite-code").value.trim().toUpperCase();
  const msg = $("setup-message");
  try {
    const team = await findTeamByInviteCode(code);
    if (!team) {
      msg.textContent = "その招待コードのチームが見つかりませんでした。";
      return;
    }
    await saveUserProfile(state.user.uid, { teamId: team.id, role: "member" });
    await loadProfileAndTeam();
    msg.textContent = "";
    await route();
  } catch (e) {
    console.error(e);
    msg.textContent = "参加に失敗しました。通信環境を確認してください。";
  }
});

// ---------------- ログアウト ----------------
async function doLogout() {
  try { await logout(); } catch (e) { console.error(e); }
}
$("setup-logout").addEventListener("click", doLogout);
$("btn-logout").addEventListener("click", doLogout);

// ---------------- タブ ----------------
document.querySelectorAll(".tab-bar button").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(tab) {
  document.querySelectorAll(".tab-bar button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  $("tab-home").hidden = tab !== "home";
  $("tab-record").hidden = tab !== "record";
  $("tab-team").hidden = tab !== "team";
  if (tab === "home") renderHome();
  if (tab === "team") renderTeam();
}

// ---------------- ホーム ----------------
document.querySelectorAll("[data-range]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.homeRange = btn.dataset.range;
    document.querySelectorAll("[data-range]").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderHome();
  });
});

function renderHome() {
  const range = state.homeRange;
  $("home-range-title").textContent = { today: "今日", month: "今月", total: "通算" }[range];
  const list = state.myPractices.filter((p) => inRange(p.date, range));
  const st = sumStats(list);
  $("home-rate-graph").innerHTML = targetGraphSvg(st.shots, st.hits);
  $("home-shots").textContent = st.shots;
  $("home-hits").textContent = st.hits;
  $("home-rate").textContent = st.shots ? `的中率 ${rateText(st.shots, st.hits)}` : "まだ記録がありません";
  $("home-tachi").textContent = `${st.tachi.shots}射 ${st.tachi.hits}中（${rateText(st.tachi.shots, st.tachi.hits)}）`;
  $("home-shakomi").textContent = `${st.shakomi.shots}射 ${st.shakomi.hits}中（${rateText(st.shakomi.shots, st.shakomi.hits)}）`;

  const box = $("home-recent");
  if (!state.myPractices.length) {
    box.innerHTML = '<p class="empty">まだ記録がありません。「記録」から入力してみてください。</p>';
    return;
  }
  box.innerHTML = "";
  for (const p of state.myPractices.slice(0, 10)) {
    const stp = practiceStats(p);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "practice-item";
    const lines = groupLines(p).map((g) =>
      `<span class="sub">${esc(g.label)}</span> <span class="shots-line">${marksHtml(g.marks)}</span>`
    ).join("<br>");
    btn.innerHTML = `
      <span class="date">${esc(p.date)}</span>${p.incomplete ? '<span class="badge">未完了</span>' : ""}
      <br>${lines || '<span class="sub">記録なし</span>'}
      <br><span class="sub">${stp.shots}射 ${stp.hits}中（${rateText(stp.shots, stp.hits)}）${p.memo ? " ／ " + esc(p.memo) : ""}</span>`;
    btn.addEventListener("click", () => {
      loadIntoEditor(p);
      switchTab("record");
    });
    box.appendChild(btn);
  }
}

// ---------------- 記録エディタ ----------------
function resetEditor(dateStr) {
  editor.practiceId = null;
  editor.date = dateStr || todayStr();
  editor.memo = "";
  editor.work = { tachi: { shots: [], yasho: [] }, shakomi: { shots: [], yasho: [] } };
  $("record-date").value = editor.date;
  $("record-memo").value = "";
  $("record-message").textContent = "";
  renderEditor();
}

function loadIntoEditor(p) {
  editor.practiceId = p.id;
  editor.date = p.date;
  editor.memo = p.memo || "";
  editor.work = { tachi: { shots: [], yasho: [] }, shakomi: { shots: [], yasho: [] } };
  for (const e of p.entries || []) {
    if (!editor.work[e.type]) continue;
    editor.work[e.type].shots = [...(e.shots || [])];
    editor.work[e.type].yasho = (e.shots || []).map((_, i) => (e.yasho && e.yasho[i]) || null);
  }
  $("record-date").value = editor.date;
  $("record-memo").value = editor.memo;
  $("record-message").textContent = "";
  renderEditor();
}

// 日付を変えたら、その日の既存記録があれば読み込む
$("record-date").addEventListener("change", () => {
  const d = $("record-date").value || todayStr();
  const existing = state.myPractices.find((p) => p.date === d);
  if (existing) loadIntoEditor(existing);
  else resetEditor(d);
});
$("btn-new-record").addEventListener("click", () => resetEditor(todayStr()));

$("mode-tachi").addEventListener("click", () => setMode("tachi"));
$("mode-shakomi").addEventListener("click", () => setMode("shakomi"));
function setMode(mode) {
  editor.mode = mode;
  $("mode-tachi").classList.toggle("active", mode === "tachi");
  $("mode-shakomi").classList.toggle("active", mode === "shakomi");
  renderEditor();
}

function editorEntries() {
  // 保存形式（entries 配列）に変換。空の形式は含めない
  const entries = [];
  for (const type of ["tachi", "shakomi"]) {
    const w = editor.work[type];
    if (w.shots.length) entries.push({ type, shots: [...w.shots], yasho: [...w.yasho] });
  }
  return entries;
}
function editorIncomplete() {
  for (const type of ["tachi", "shakomi"]) {
    const n = editor.work[type].shots.length;
    if (n && n % GROUP_SIZE[type] !== 0) return true;
  }
  return false;
}

function renderEditor() {
  const wrap = $("record-groups");
  wrap.innerHTML = "";
  let any = false;
  for (const type of ["tachi", "shakomi"]) {
    const w = editor.work[type];
    if (!w.shots.length) continue;
    any = true;
    const size = GROUP_SIZE[type];
    for (let i = 0; i < w.shots.length; i += size) {
      const div = document.createElement("div");
      div.className = "group";
      const idx = w.shots.slice(i, i + size);
      div.innerHTML = `<div class="g-title">${TYPE_LABEL[type]} ${Math.floor(i / size) + 1}${idx.length < size ? "（途中）" : ""}</div>`;
      const chips = document.createElement("div");
      chips.className = "chips";
      idx.forEach((shot, j) => {
        const globalIdx = i + j;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip " + (shot ? "o" : "x");
        chip.textContent = shot ? "○" : "×";
        chip.title = "タップで○×を直す";
        if (shot && w.yasho[globalIdx]) {
          const dot = document.createElement("span");
          dot.className = "dot";
          chip.appendChild(dot);
        }
        chip.addEventListener("click", () => {
          w.shots[globalIdx] = !w.shots[globalIdx];
          if (!w.shots[globalIdx]) w.yasho[globalIdx] = null; // ×にしたら矢所は消す
          renderEditor();
        });
        chips.appendChild(chip);
      });
      div.appendChild(chips);
      wrap.appendChild(div);
    }
  }
  if (!any) {
    wrap.innerHTML = '<p class="empty">まだ入力がありません。下のボタンで1射ずつ入力してください。</p>';
  }
  const st = sumStats([{ entries: editorEntries() }]);
  $("record-status").textContent =
    `合計 ${st.shots}射 ${st.hits}中（${rateText(st.shots, st.hits)}）` +
    (editorIncomplete() ? " ／ 最後が途中です（このまま保存でき、未完了として記録されます）" : "");
  $("btn-delete").hidden = !editor.practiceId;
}

function addShot(hit) {
  const w = editor.work[editor.mode];
  w.shots.push(hit);
  w.yasho.push(null);
  renderEditor();
  if (hit) {
    // ○の直後に矢所（任意）を聞く
    openYashoPanel(editor.mode, w.shots.length - 1);
  }
}
$("btn-hit").addEventListener("click", () => addShot(true));
$("btn-miss").addEventListener("click", () => addShot(false));
$("btn-undo").addEventListener("click", () => {
  const w = editor.work[editor.mode];
  if (w.shots.length) { w.shots.pop(); w.yasho.pop(); renderEditor(); }
});

$("btn-save").addEventListener("click", async () => {
  const entries = editorEntries();
  const msg = $("record-message");
  if (!entries.length) {
    msg.textContent = "まだ入力がありません。";
    return;
  }
  editor.memo = $("record-memo").value.trim();
  const data = {
    uid: state.user.uid,
    teamId: state.profile.teamId,
    date: editor.date,
    entries,
    memo: editor.memo,
    incomplete: editorIncomplete()
  };
  try {
    editor.practiceId = await savePractice(editor.practiceId, data);
    await refreshData();
    renderHome();
    showSummary(data);
    msg.textContent = "";
  } catch (e) {
    console.error(e);
    msg.textContent = "保存に失敗しました。通信環境を確認してください。";
  }
});

$("btn-delete").addEventListener("click", async () => {
  if (!editor.practiceId) return;
  if (!window.confirm("この日の記録を削除します。よろしいですか？")) return;
  try {
    await removePractice(editor.practiceId);
    await refreshData();
    resetEditor(editor.date);
    renderHome();
  } catch (e) {
    console.error(e);
    $("record-message").textContent = "削除に失敗しました。";
  }
});

function showSummary(data) {
  const st = sumStats([data]);
  const row = (label, s) =>
    `<tr><td>${label}</td><td>${s.shots}射 ${s.hits}中（${rateText(s.shots, s.hits)}）</td></tr>`;
  $("summary-body").innerHTML = `
    <table>
      ${row("立", st.tachi)}
      ${row("射込み", st.shakomi)}
      ${row("合計", st)}
    </table>
    ${data.incomplete ? '<p class="note">最後が途中のため「未完了」として記録しました。</p>' : ""}`;
  $("summary-panel").hidden = false;
}
$("btn-summary-close").addEventListener("click", () => { $("summary-panel").hidden = true; });

// ---------------- 矢所パネル ----------------
// yashoTarget: { type, index } 編集中の1射
let yashoTarget = null;

function shotLabel(type, index) {
  const size = GROUP_SIZE[type];
  const group = Math.floor(index / size) + 1;
  const pos = (index % size) + 1;
  return `${TYPE_LABEL[type]} ${group} の ${pos} 射目`;
}

function openYashoPanel(type, index) {
  yashoTarget = { type, index };
  $("yasho-target-label").textContent =
    `${shotLabel(type, index)} の矢所：的中した位置をタップしてください。入力しなくても大丈夫です。`;
  renderYashoPad();
  $("yasho-panel").hidden = false;
}

function renderYashoPad() {
  if (!yashoTarget) return;
  const w = editor.work[yashoTarget.type];
  const current = w.yasho[yashoTarget.index];
  $("yasho-pad").innerHTML = targetPadSvg(current ? [current] : [], true);
  const svg = $("yasho-svg");
  if (svg) {
    svg.addEventListener("click", (ev) => {
      const rect = svg.getBoundingClientRect();
      // 画面上のタップ位置 → 的の中心からの相対座標（-1〜1、右・下が正）
      const px = (ev.clientX - rect.left) / rect.width;   // 0〜1
      const py = (ev.clientY - rect.top) / rect.height;   // 0〜1
      let x = (px * 220 - 110) / 100;
      let y = (py * 220 - 110) / 100;
      x = Math.max(-1, Math.min(1, Math.round(x * 100) / 100));
      y = Math.max(-1, Math.min(1, Math.round(y * 100) / 100));
      w.yasho[yashoTarget.index] = { x, y };
      renderYashoPad();
      renderEditor();
    });
  }
}

function closeYashoPanel() {
  yashoTarget = null;
  $("yasho-panel").hidden = true;
}
$("btn-yasho-skip").addEventListener("click", closeYashoPanel);
$("btn-yasho-done").addEventListener("click", closeYashoPanel);
$("btn-yasho-clear").addEventListener("click", () => {
  if (!yashoTarget) return;
  editor.work[yashoTarget.type].yasho[yashoTarget.index] = null;
  renderYashoPad();
  renderEditor();
});

// 「矢所の入力・修正」：的中した射の一覧から選んで開く
$("btn-yasho-edit").addEventListener("click", () => {
  const hits = [];
  for (const type of ["tachi", "shakomi"]) {
    editor.work[type].shots.forEach((s, i) => {
      if (s) hits.push({ type, index: i, has: !!editor.work[type].yasho[i] });
    });
  }
  if (!hits.length) {
    $("record-message").textContent = "的中した射がまだありません。";
    return;
  }
  $("yasho-target-label").textContent = "矢所を入力・修正する射を選んでください。";
  const pad = $("yasho-pad");
  pad.innerHTML = "";
  const list = document.createElement("div");
  list.style.width = "100%";
  list.style.display = "grid";
  list.style.gap = "0.45rem";
  for (const h of hits) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = `${shotLabel(h.type, h.index)}（${h.has ? "入力済み" : "未入力"}）`;
    b.addEventListener("click", () => openYashoPanel(h.type, h.index));
    list.appendChild(b);
  }
  pad.appendChild(list);
  yashoTarget = null;
  $("yasho-panel").hidden = false;
});

// ---------------- チーム ----------------
document.querySelectorAll("[data-trange]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.teamRange = btn.dataset.trange;
    document.querySelectorAll("[data-trange]").forEach((b) =>
      b.classList.toggle("active", b === btn));
    state.detailUid = null;
    renderTeam();
  });
});

function memberName(uid) {
  const m = state.members.find((x) => x.id === uid);
  return m ? m.name : "（不明）";
}

function renderTeam() {
  if (!state.team) return;
  const isLeader = state.profile.role === "leader";
  $("team-title").textContent = state.team.name;
  $("team-info").textContent = `メンバー ${state.members.length}人`;
  $("team-code").textContent = state.team.inviteCode || "";

  const range = state.teamRange;
  const list = state.teamPractices.filter((p) => inRange(p.date, range));
  const st = sumStats(list);
  $("team-total").textContent =
    `${range === "month" ? "今月" : "通算"}：${st.shots}射 ${st.hits}中（的中率 ${rateText(st.shots, st.hits)}）`;

  const wrap = $("team-members");
  wrap.innerHTML = "";
  $("team-member-note").hidden = isLeader;

  if (isLeader) {
    // メンバー別集計（リーダーのみ）
    const rows = state.members.map((m) => {
      const mine = list.filter((p) => p.uid === m.id);
      return { member: m, st: sumStats(mine) };
    }).sort((a, b) => b.st.shots - a.st.shots);
    for (const r of rows) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "member-row";
      b.innerHTML = `
        <span><span class="m-name">${esc(r.member.name)}</span>
        <span class="m-sub">${r.member.grade ? esc(r.member.grade) + " ／ " : ""}${r.member.id === state.user.uid ? "自分" : ""}</span></span>
        <span>${r.st.shots}射 ${r.st.hits}中（${rateText(r.st.shots, r.st.hits)}）</span>`;
      b.addEventListener("click", () => renderMemberDetail(r.member.id));
      wrap.appendChild(b);
    }
    if (!rows.length) wrap.innerHTML = '<p class="empty">メンバーがいません。</p>';
  }
  // 一般メンバーには合計だけ（他人の詳細は出さない）
  if (state.detailUid && isLeader) {
    // 詳細は renderMemberDetail で表示済み
  } else {
    $("member-detail-card").hidden = true;
    $("team-summary-card").hidden = false;
  }
}

function renderMemberDetail(uid) {
  if (state.profile.role !== "leader") return;
  state.detailUid = uid;
  const range = state.teamRange;
  const list = state.teamPractices.filter((p) => p.uid === uid && inRange(p.date, range));
  const st = sumStats(list);
  $("detail-name").textContent = `${memberName(uid)} さんの記録`;
  $("detail-summary").textContent =
    `${range === "month" ? "今月" : "通算"}：${st.shots}射 ${st.hits}中（的中率 ${rateText(st.shots, st.hits)}）`;

  // 矢所の散布図（期間内の全記録ぶん）
  const points = [];
  for (const p of list) {
    for (const e of p.entries || []) {
      (e.shots || []).forEach((s, i) => {
        const y = e.yasho && e.yasho[i];
        if (s && y) points.push(y);
      });
    }
  }
  $("detail-yasho").innerHTML = points.length
    ? targetPadSvg(points, false)
    : '<p class="empty">矢所の記録はありません。</p>';

  const box = $("detail-list");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<p class="empty">この期間の記録はありません。</p>';
  }
  for (const p of list) {
    const stp = practiceStats(p);
    const div = document.createElement("div");
    div.className = "practice-item";
    const lines = groupLines(p).map((g) =>
      `<span class="sub">${esc(g.label)}</span> <span class="shots-line">${marksHtml(g.marks)}</span>${g.partial ? ' <span class="sub">（途中）</span>' : ""}`
    ).join("<br>");
    div.innerHTML = `
      <span class="date">${esc(p.date)}</span>${p.incomplete ? '<span class="badge">未完了</span>' : ""}
      <br>${lines}
      <br><span class="sub">${stp.shots}射 ${stp.hits}中（${rateText(stp.shots, stp.hits)}）</span>
      ${p.memo ? `<br><span class="sub">メモ：${esc(p.memo)}</span>` : ""}`;
    box.appendChild(div);
  }

  $("team-summary-card").hidden = true;
  $("member-detail-card").hidden = false;
}
$("btn-detail-back").addEventListener("click", () => {
  state.detailUid = null;
  $("member-detail-card").hidden = true;
  $("team-summary-card").hidden = false;
});

// ---------------- CSV出力 ----------------
$("btn-csv").addEventListener("click", () => {
  const range = $("csv-range").value; // month | lastMonth | total
  const isLeader = state.profile.role === "leader";
  const source = isLeader ? state.teamPractices : state.myPractices;
  const list = source
    .filter((p) => inRange(p.date, range))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const rows = [["日付", "メンバー名", "形式", "射数", "的中数", "的中率", "メモ"]];
  for (const p of list) {
    for (const e of p.entries || []) {
      const shots = (e.shots || []).length;
      const hits = (e.shots || []).filter(Boolean).length;
      rows.push([
        p.date,
        memberName(p.uid),
        TYPE_LABEL[e.type] || e.type,
        shots,
        hits,
        shots ? Math.round((hits / shots) * 100) + "%" : "",
        p.memo || ""
      ]);
    }
  }
  const msg = $("csv-message");
  if (rows.length <= 1) {
    msg.textContent = "その期間の記録がありません。";
    return;
  }
  const csv = rows.map((r) =>
    r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")
  ).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kyudocho_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  msg.textContent = "CSVをダウンロードしました。";
});

// ---------------- 開始 ----------------
boot();
