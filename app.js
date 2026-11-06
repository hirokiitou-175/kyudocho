// 弓道帳（チーム版）— 画面と処理
// 構成：ログイン（メールリンク）→ プロフィール → チーム所属 → ホーム／記録／チーム
import {
  auth,
  isEmailLink,
  signInWithId,
  signUpWithEmail,
  pseudoEmailFor,
  deleteCurrentUser,
  claimLoginId,
  releaseLoginId,
  setAccountPassword,
  hasPasswordProvider,
  watchAuth,
  logout,
  getUserProfile,
  saveUserProfile,
  updateMemberProfile,
  removeMemberFromTeam,
  createTeam,
  findTeamByInviteCode,
  getTeam,
  listTeamMembers,
  listPracticesByUser,
  listPracticesByTeam,
  savePractice,
  removePractice,
  deletePractices,
  transferPractices
} from "./firebase.js?v=20251105-26";

// ---------------- 状態 ----------------
const state = {
  user: null,          // Firebase Auth のユーザー
  profile: null,       // users/{uid}
  team: null,          // teams/{teamId}
  members: [],         // 同じチームの users
  myPractices: [],     // 自分の practices（日付の新しい順）
  teamPractices: [],   // チーム全員の practices
  homeRange: "total",  // today | month | total
  homeTrendUnit: "day", // ホームの推移グラフの単位 day | week
  homeTrendRange: "30days", // ホームの推移グラフの期間 30days | month | total
  teamRange: "month",  // month | total
  detailUid: null,     // メンバー詳細で表示中の uid
  pendingTransfer: null, // 引き継ぎ最終確認の内容 { fromUid, toUid, count }
  analysisOpen: false, // 分析シートを表示中か
  analysisPersonal: false, // 分析シートを「自分の記録だけ」で表示中か（生徒用）
  analysisStart: "",   // 分析シートの期間（開始日）
  analysisEnd: "",     // 分析シートの期間（終了日）
  analysisUnit: "day", // 分析シートの集計単位 day | week
  analysisSelected: [], // 分析シートで比べるメンバーの uid
  analysisInit: false, // 分析シートの初期選択が済んだか
  registering: false   // 新規登録の処理中は watchAuth の画面遷移を止める
};

// 記録編集中の内容（1日分）
// work[type].shots: true=○ / false=×
// work[type].yashoGroups: 立（グループ）ごとの矢所の点 [{x,y}, ...] の配列。
//   矢所は○×や何本目かとは結びつけず、外れも含めて立ごとにまとめて記録する。
const editor = {
  practiceId: null,
  date: todayStr(),
  mode: "tachi",
  memo: "",
  work: {
    tachi: { shots: [], yashoGroups: [] },
    shakomi: { shots: [], yashoGroups: [] }
  }
};

function emptyWork() {
  return { tachi: { shots: [], yashoGroups: [] }, shakomi: { shots: [], yashoGroups: [] } };
}

// 旧形式（1射ごとの yasho 配列）から、立ごとの yashoGroups へ変換する
function yashoGroupsFromEntry(e) {
  if (Array.isArray(e.yashoGroups)) {
    return e.yashoGroups.map((g) => (g || []).map((pt) => ({ x: pt.x, y: pt.y })));
  }
  const size = GROUP_SIZE[e.type] || 4;
  const groups = [];
  (e.shots || []).forEach((_, i) => {
    const y = e.yasho && e.yasho[i];
    if (!y) return;
    const g = Math.floor(i / size);
    if (!groups[g]) groups[g] = [];
    groups[g].push({ x: y.x, y: y.y });
  });
  return groups;
}

// その立（グループ）の射数。shots の並びから数える
function groupShotCount(type, group) {
  const size = GROUP_SIZE[type];
  const total = editor.work[type].shots.length;
  return Math.max(0, Math.min(size, total - group * size));
}

// 矢所の点が、その立の射数を超えていたら切り詰める（射を減らしたとき用）
function trimYashoGroups(type) {
  const w = editor.work[type];
  const size = GROUP_SIZE[type];
  const groupCount = Math.ceil(w.shots.length / size);
  w.yashoGroups.length = groupCount;
  for (let g = 0; g < groupCount; g++) {
    const pts = w.yashoGroups[g] || [];
    w.yashoGroups[g] = pts.slice(0, groupShotCount(type, g));
  }
}

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
// 霞的（直径36cmの区分どおりの同心円）の、外周（黒い淵の外側）に
// 朱色のメーター（弧）で的中率を表す。
// 的の半径18cmを54pxに換算：中白10.8／1の黒21.6まで／2の白30.6まで／
// 2の黒35.1まで／3の白44.1まで／外黒54。メーターは半径58.5（的の外側）。
function targetGraphSvg(shots, hits) {
  const rate = shots ? hits / shots : 0;
  const C = 2 * Math.PI * 58.5;
  const arc = shots ? (C * rate).toFixed(1) : "0";
  const center = shots ? Math.round(rate * 100) + "%" : "―";
  return `
  <svg viewBox="0 0 128 128" role="img" aria-label="的中率 ${center}">
    <circle cx="64" cy="64" r="54" fill="#2b2b28"/>
    <circle cx="64" cy="64" r="44.1" fill="#fffdf7"/>
    <circle cx="64" cy="64" r="35.1" fill="#2b2b28"/>
    <circle cx="64" cy="64" r="30.6" fill="#fffdf7"/>
    <circle cx="64" cy="64" r="21.6" fill="#2b2b28"/>
    <circle cx="64" cy="64" r="10.8" fill="#fffdf7"/>
    <circle cx="64" cy="64" r="58.5" fill="none" stroke="#c73e2c" stroke-width="5"
      stroke-dasharray="${arc} ${C.toFixed(1)}" transform="rotate(-90 64 64)" stroke-linecap="round"/>
    <rect x="41" y="80" width="46" height="22" rx="6" fill="#faf6ec" stroke="#2b2b28" stroke-width="1"/>
    <text x="64" y="96" text-anchor="middle" font-size="15" font-weight="700" fill="#2b2b28">${center}</text>
  </svg>`;
}

// 矢所の的（入力用・表示用で共用）。points: [{x,y}]（中心=0、右・下が正、-1〜1）
function targetPadSvg(points, clickable) {
  const dots = (points || []).map((pt) => {
    const cx = (110 + pt.x * 100).toFixed(1);
    const cy = (110 + pt.y * 100).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="#c73e2c" fill-opacity="0.75" stroke="#fff" stroke-width="1.5"/>`;
  }).join("");
  // 霞的（直径36cm）の区分どおりの同心円：中心から
  // 中白 半径3.6cm／1の黒 幅3.6／2の白 幅3.0／2の黒 幅1.5／3の白 幅3.0／外黒 幅3.3。
  // 半径18cmを104pxに換算して円を重ねている。
  return `
  <svg viewBox="0 0 220 220" ${clickable ? 'id="yasho-svg"' : ""} role="img" aria-label="的">
    <circle cx="110" cy="110" r="104" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="84.9" fill="#fffdf7"/>
    <circle cx="110" cy="110" r="67.6" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="58.9" fill="#fffdf7"/>
    <circle cx="110" cy="110" r="41.6" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="20.8" fill="#fffdf7"/>
    ${dots}
  </svg>`;
}

// ---------------- 画面の切り替え ----------------
function showView(id) {
  for (const v of ["view-loading", "view-login", "view-profile", "view-setup", "view-team-setup", "view-main"]) {
    $(v).hidden = v !== id;
  }
}

// 初回設定（名前・ログインID・パスワード）が済んでいるか。
// 済んでいない間は、チーム作成・招待コード入力へ進めない。
function needsAccountSetup() {
  if (!state.user) return false;
  if (!state.profile || !state.profile.name) return true;
  if (!state.profile.loginId) return true;
  if (!hasPasswordProvider(state.user)) return true;
  return false;
}

function renderSetup() {
  const p = state.profile;
  if (p) {
    if (!$("setup-name").value && p.name) $("setup-name").value = p.name;
    if (!$("setup-grade").value && p.grade) $("setup-grade").value = p.grade;
    if (!$("setup-id").value && p.loginId) $("setup-id").value = p.loginId;
  }
  $("setup-password-note").textContent = hasPasswordProvider(state.user)
    ? "パスワードは設定済みです。変えるときだけ入力してください。"
    : "";
}

async function route() {
  if (!state.user) { showView("view-login"); return; }
  if (needsAccountSetup()) { renderSetup(); showView("view-setup"); return; }
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
function startWatch() {
  watchAuth(async (user) => {
    state.user = user;
    // 新規登録の途中（アカウント作成直後など）は画面遷移しない
    if (state.registering) return;
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

// ダブルタップ（ダブルクリック）で画面が拡大しないようにする保険。
// 拡大縮小はピンチ操作だけに任せる。入力欄でのダブルタップ（単語選択など）は妨げない。
document.addEventListener("dblclick", (ev) => {
  if (ev.target.closest("input, textarea")) return;
  ev.preventDefault();
}, { passive: false });

async function boot() {
  // メールリンクでのログインは終了した。古いリンクを開いた人への案内だけ出す。
  if (isEmailLink(window.location.href)) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showView("view-login");
    $("login-message").textContent =
      "メールリンクでのログインは終了しました。ログインIDとパスワードでログインしてください。初めての方は「招待コードで参加」から登録できます。";
  }
  startWatch();
}

// ---------------- ログイン・新規登録 ----------------
// ログインIDのルール：6文字以上。使える文字は自由だが、保存の仕組み上
// どうしても使えない形（/ を含む、. や .. のみ、__ で囲まれた形）だけ除く。
// 大文字・小文字は区別する（登録したとおりに入力してもらう）。
function loginIdError(id) {
  if ([...id].length < 6) return "ログインIDは6文字以上で入力してください。";
  if (id.includes("/") || id === "." || id === ".." || /^__.*__$/.test(id)) {
    return "そのログインIDは使えません。別のIDにしてください。";
  }
  return "";
}

// 登録の進み具合（招待コードで参加／チームを作る）
const regState = { mode: null, code: "" };

function showRegForm() {
  const isCreate = regState.mode === "create";
  $("join-code-form").hidden = true;
  $("reg-form").hidden = false;
  $("reg-team-wrap").hidden = !isCreate;
  $("reg-back").hidden = isCreate;
  $("reg-context").textContent = isCreate
    ? "チームを作る人の登録です。登録すると、あなたがそのチームのリーダーになります。"
    : `招待コード「${regState.code}」のチームに参加します。`;
  $("reg-submit").textContent = isCreate ? "登録してチームを作る" : "登録してチームに参加する";
}

// 入口タブの切り替え（ログイン／招待コードで参加／チームを作る）
function setLoginTab(which) {
  $("login-tab-login").classList.toggle("active", which === "login");
  $("login-tab-join").classList.toggle("active", which === "join");
  $("login-tab-create").classList.toggle("active", which === "create");
  $("login-id-form").hidden = which !== "login";
  $("join-code-form").hidden = true;
  $("reg-form").hidden = true;
  $("login-message").textContent = "";
  $("login-message").classList.remove("ok");
  if (which === "join") {
    regState.mode = "join";
    if (regState.code) showRegForm();
    else $("join-code-form").hidden = false;
  } else if (which === "create") {
    regState.mode = "create";
    showRegForm();
  }
}
$("login-tab-login").addEventListener("click", () => setLoginTab("login"));
$("login-tab-join").addEventListener("click", () => setLoginTab("join"));
$("login-tab-create").addEventListener("click", () => setLoginTab("create"));

$("login-id-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const loginId = $("login-id").value.trim();
  const password = $("login-password").value;
  const msg = $("login-message");
  $("login-id-send").disabled = true;
  try {
    await signInWithId(loginId, password);
    msg.textContent = "";
    // ログイン後の画面遷移は watchAuth → route() が行う
  } catch (e) {
    console.error(e);
    msg.textContent = "ログインできませんでした。IDとパスワードを確認してください。";
    msg.classList.remove("ok");
  } finally {
    $("login-id-send").disabled = false;
  }
});

// 招待コードの入力（登録フォームへ進むだけ。コードの確認は登録の直後に行う）
$("join-code-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const code = $("join-code").value.trim().toUpperCase();
  if (!code) return;
  regState.code = code;
  setLoginTab("join");
});
$("reg-back").addEventListener("click", () => {
  regState.code = "";
  setLoginTab("join");
});

// 新規登録（アカウント作成→ID登録→チーム参加または作成→プロフィール保存）
$("reg-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("login-message");
  msg.classList.remove("ok");
  const loginId = $("reg-id").value.trim();
  // メールアドレスは使わない。ログインIDから内部専用のダミー文字列を作って使う。
  const email = pseudoEmailFor(loginId);
  const name = $("reg-name").value.trim();
  const grade = $("reg-grade").value.trim();
  const password = $("reg-password").value;
  const password2 = $("reg-password2").value;
  const isCreate = regState.mode === "create";
  const teamName = isCreate ? $("reg-team-name").value.trim() : "";

  const idErr = loginIdError(loginId);
  if (idErr) {
    msg.textContent = idErr;
    return;
  }
  if (!name) {
    msg.textContent = "名前を入力してください。";
    return;
  }
  if (password.length < 6) {
    msg.textContent = "パスワードは6文字以上で入力してください。";
    return;
  }
  if (password !== password2) {
    msg.textContent = "パスワード（確認）が一致しません。";
    return;
  }
  if (isCreate && !teamName) {
    msg.textContent = "チーム名を入力してください。";
    return;
  }
  if (!isCreate && !regState.code) {
    msg.textContent = "先に招待コードを入力してください。";
    setLoginTab("join");
    return;
  }

  $("reg-submit").disabled = true;
  state.registering = true;
  let cred = null;
  try {
    cred = await signUpWithEmail(email, password);
    state.user = cred.user;
    await claimLoginId(loginId, cred.user.uid, email);
    let team = null;
    let teamId = null;
    let role = null;
    if (isCreate) {
      team = await createTeam(teamName, cred.user.uid);
      teamId = team.id;
      role = "leader";
    } else {
      team = await findTeamByInviteCode(regState.code);
      if (team) {
        teamId = team.id;
        role = "member";
      }
    }
    await saveUserProfile(cred.user.uid, {
      name,
      grade: grade || null,
      loginId,
      teamId,
      role
    });
    state.registering = false;
    await loadProfileAndTeam();
    await route();
    if (!isCreate && !team) {
      // コードのチームが見つからなかった。アカウントはできているので、
      // チーム参加の画面でコードを入れ直してもらう。
      $("setup-message").textContent = "アカウントは作成できましたが、招待コードのチームが見つかりませんでした。正しいコードを入力してください。";
    }
  } catch (e) {
    console.error(e);
    state.registering = false;
    if (cred && e.code === "app/id-taken") {
      // IDが使われていたら、作ったばかりのアカウントを取り消してやり直せるようにする
      try { await deleteCurrentUser(cred.user); } catch (e2) { console.error(e2); }
      state.user = null;
      msg.textContent = "そのログインIDは既に使われています。別のIDにしてください。";
    } else if (e.code === "auth/email-already-in-use") {
      // 内部IDはログインIDから作るため、このエラーは「IDが使用済み」を意味する
      msg.textContent = "そのログインIDは既に使われています。別のIDにしてください。";
    } else if (e.code === "auth/weak-password") {
      msg.textContent = "パスワードは6文字以上で入力してください。";
    } else if (e.code === "auth/operation-not-allowed") {
      msg.textContent = "アカウントの登録が有効になっていません。管理者に連絡してください。";
    } else {
      msg.textContent = "登録に失敗しました。通信環境を確認してもう一度お試しください。";
    }
  } finally {
    $("reg-submit").disabled = false;
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
      role: state.profile?.role ?? null
    });
    await loadProfileAndTeam();
    await route();
  } catch (e) {
    console.error(e);
    $("profile-message").textContent = "保存に失敗しました。通信環境を確認してください。";
  }
});

// ---------------- 初回設定（名前・ログインID・パスワード） ----------------
$("setup-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("setup-message");
  const name = $("setup-name").value.trim();
  const grade = $("setup-grade").value.trim();
  const loginId = $("setup-id").value.trim();
  const password = $("setup-password").value;
  const currentId = state.profile?.loginId || null;
  const pwAlreadySet = hasPasswordProvider(state.user);

  if (!name) { msg.textContent = "名前を入力してください。"; return; }
  const idErr = loginIdError(loginId);
  if (idErr) {
    msg.textContent = idErr;
    return;
  }
  if (!pwAlreadySet && password.length < 6) {
    msg.textContent = "パスワードは6文字以上で入力してください。";
    return;
  }
  if (pwAlreadySet && password && password.length < 6) {
    msg.textContent = "パスワードを変える場合は、6文字以上で入力してください。";
    return;
  }

  try {
    if (loginId !== currentId) {
      await claimLoginId(loginId, state.user.uid, state.user.email);
      if (currentId) {
        try { await releaseLoginId(currentId); } catch (e) { console.error(e); }
      }
    }
    await saveUserProfile(state.user.uid, {
      name,
      grade: grade || null,
      loginId
    });
    if (password) await setAccountPassword(state.user, password);
    $("setup-password").value = "";
    msg.textContent = "";
    await loadProfileAndTeam();
    await route();
  } catch (e) {
    console.error(e);
    if (e.code === "app/id-taken") {
      msg.textContent = "そのログインIDは既に使われています。別のIDにしてください。";
    } else if (e.code === "auth/requires-recent-login") {
      msg.textContent = "安全のため、一度ログアウトして、メールリンクでログインし直してから設定してください。";
    } else if (e.code === "auth/operation-not-allowed") {
      msg.textContent = "パスワードでのログインがまだ有効になっていません。管理者（Firebaseの設定）側の有効化が必要です。";
    } else {
      msg.textContent = "保存に失敗しました。通信環境を確認してもう一度お試しください。";
    }
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

  renderHomeTrend();
}

// ホームの推移グラフの期間（開始日・終了日）
function homeTrendWindow() {
  const today = todayStr();
  if (state.homeTrendRange === "month") {
    return { start: `${monthStr(0)}-01`, end: today };
  }
  if (state.homeTrendRange === "total") {
    const dates = state.myPractices.map((p) => p.date).filter(Boolean).sort();
    let start = dates.length ? dates[0] : addDaysStr(today, -29);
    // 日ごとのときは最大で過去1年分まで
    if (state.homeTrendUnit === "day" && daysBetween(start, today) > 365) {
      start = addDaysStr(today, -365);
    }
    return { start, end: today };
  }
  return { start: addDaysStr(today, -29), end: today };
}

// ホーム：自分の的中率推移グラフ＋矢所ヒートマップ
function renderHomeTrend() {
  if (!state.user) return;
  const { start, end } = homeTrendWindow();
  const unit = state.homeTrendUnit;
  const buckets = analysisBuckets(start, end, unit);
  const list = state.myPractices.filter((p) => p.date >= start && p.date <= end);
  const byKey = new Map(buckets.map((b) => [b.key, { ...b, shots: 0, hits: 0 }]));
  for (const p of list) {
    const key = unit === "day" ? p.date : weekStartStr(p.date);
    const b = byKey.get(key);
    if (!b) continue;
    const st = practiceStats(p);
    b.shots += st.shots;
    b.hits += st.hits;
  }
  const agg = [...byKey.values()].map((b) => ({
    ...b,
    rate: b.shots ? b.hits / b.shots : null
  }));
  const total = sumStats(list);
  const me = state.members.find((m) => m.id === state.user.uid) ||
    { name: state.profile?.name || "自分" };
  const points = collectYashoPoints(list);
  const series = [{
    member: me,
    uid: state.user.uid,
    color: ANALYSIS_COLORS[0],
    list,
    buckets: agg,
    total,
    points
  }];
  $("home-trend-summary").textContent =
    `${start} ～ ${end}：${total.shots}射 ${total.hits}中（${rateText(total.shots, total.hits)}）／立 ${rateText(total.tachi.shots, total.tachi.hits)}・射込み ${rateText(total.shakomi.shots, total.shakomi.hits)}`;
  const hasData = agg.some((b) => b.rate !== null);
  $("home-trend").innerHTML = hasData
    ? trendChartSvg(series, buckets)
    : '<p class="empty">この期間の記録はまだありません。「記録」から入力してみてください。</p>';

  // 矢所がある期間だけヒートマップを出す
  $("home-yasho-card").hidden = !points.length;
  if (points.length) {
    $("home-yasho").innerHTML = yashoHeatmapSvg(points);
    const mt = yashoMetrics(points);
    $("home-yasho-summary").textContent = mt
      ? `矢所 ${mt.count}点：多い場所は${mt.area}（${mt.areaPct}%）、中心からの平均 ${mt.meanDistCm}cm、重心は${mt.centroid}です。`
      : "";
  }
}

document.querySelectorAll("[data-htunit]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.homeTrendUnit = btn.dataset.htunit;
    document.querySelectorAll("[data-htunit]").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderHomeTrend();
  });
});
document.querySelectorAll("[data-htrange]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.homeTrendRange = btn.dataset.htrange;
    document.querySelectorAll("[data-htrange]").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderHomeTrend();
  });
});

// 矢所のヒートマップ（霞的の上に、集まり具合を色の濃さで重ねる）
function yashoHeatmapSvg(points) {
  const GRID = 20;
  const CELL = 220 / GRID;
  const counts = new Array(GRID * GRID).fill(0);
  for (const p of points) {
    const gx = Math.max(0, Math.min(GRID - 1, Math.floor((110 + p.x * 100) / CELL)));
    const gy = Math.max(0, Math.min(GRID - 1, Math.floor((110 + p.y * 100) / CELL)));
    counts[gy * GRID + gx] += 1;
  }
  // 3×3でぼかして、なめらかな濃淡にする
  const smooth = new Array(GRID * GRID).fill(0);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          sum += counts[ny * GRID + nx] * w;
        }
      }
      smooth[gy * GRID + gx] = sum / 16;
    }
  }
  const max = Math.max(...smooth, 0.0001);
  let cells = "";
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const v = smooth[gy * GRID + gx] / max;
      if (v < 0.05) continue;
      // 黄（薄い）→ 赤（濃い）へ補間する
      const green = Math.round(215 - 160 * v);
      const alpha = (0.22 + 0.68 * v).toFixed(2);
      cells += `<rect x="${gx * CELL}" y="${gy * CELL}" width="${CELL}" height="${CELL}" fill="rgb(255, ${green}, 0)" fill-opacity="${alpha}"/>`;
    }
  }
  const mx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const my = points.reduce((a, p) => a + p.y, 0) / points.length;
  const cx = 110 + mx * 100;
  const cy = 110 + my * 100;
  const cross = `M ${(cx - 9).toFixed(1)} ${cy.toFixed(1)} H ${(cx + 9).toFixed(1)} M ${cx.toFixed(1)} ${(cy - 9).toFixed(1)} V ${(cy + 9).toFixed(1)}`;
  const rings = [84.9, 67.6, 58.9, 41.6, 20.8]
    .map((r) => `<circle cx="110" cy="110" r="${r}" fill="none" stroke="#2b2b28" stroke-width="1.2"/>`)
    .join("");
  return `<svg viewBox="0 0 220 220" role="img" aria-label="矢所のヒートマップ">
    <defs><clipPath id="heat-clip"><circle cx="110" cy="110" r="104"/></clipPath></defs>
    <circle cx="110" cy="110" r="104" fill="#fffdf7"/>
    <g clip-path="url(#heat-clip)">${cells}</g>
    ${rings}
    <circle cx="110" cy="110" r="104" fill="none" stroke="#2b2b28" stroke-width="2.5"/>
    <path d="${cross}" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
    <path d="${cross}" stroke="#2b2b28" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}

// ---------------- 記録エディタ ----------------
function resetEditor(dateStr) {
  editor.practiceId = null;
  editor.date = dateStr || todayStr();
  editor.memo = "";
  editor.work = emptyWork();
  $("record-date").value = editor.date;
  $("record-memo").value = "";
  $("record-message").textContent = "";
  renderEditor();
}

function loadIntoEditor(p) {
  editor.practiceId = p.id;
  editor.date = p.date;
  editor.memo = p.memo || "";
  editor.work = emptyWork();
  for (const e of p.entries || []) {
    if (!editor.work[e.type]) continue;
    editor.work[e.type].shots = [...(e.shots || [])];
    editor.work[e.type].yashoGroups = yashoGroupsFromEntry(e);
    trimYashoGroups(e.type);
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
    if (w.shots.length) entries.push({ type, shots: [...w.shots], yashoGroups: w.yashoGroups.map((g) => (g || []).map((pt) => ({ ...pt }))) });
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
      const groupIndex = Math.floor(i / size);
      const yashoCount = (w.yashoGroups[groupIndex] || []).length;
      div.innerHTML = `<div class="g-title">${TYPE_LABEL[type]} ${groupIndex + 1}${idx.length < size ? "（途中）" : ""}</div>`;
      const row = document.createElement("div");
      row.className = "group-row";
      const chips = document.createElement("div");
      chips.className = "chips";
      idx.forEach((shot, j) => {
        const globalIdx = i + j;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip " + (shot ? "o" : "x");
        chip.textContent = shot ? "○" : "×";
        chip.title = "タップで○×を直す";
        chip.addEventListener("click", () => {
          w.shots[globalIdx] = !w.shots[globalIdx];
          renderEditor();
        });
        chips.appendChild(chip);
      });
      row.appendChild(chips);
      // 矢所は、その立・射込みの横のボタンから直接開いて入れる
      const yb = document.createElement("button");
      yb.type = "button";
      yb.className = "btn yasho-open";
      yb.textContent = `矢所（${yashoCount}／${idx.length}）`;
      yb.title = "この立・射込みの矢所を入力・修正する";
      yb.addEventListener("click", () => openYashoPanel(type, groupIndex));
      row.appendChild(yb);
      div.appendChild(row);
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
  // 矢所はここでは聞かない。各立・射込みの横の「矢所」ボタンから入れる。
  const w = editor.work[editor.mode];
  w.shots.push(hit);
  renderEditor();
}
$("btn-hit").addEventListener("click", () => addShot(true));
$("btn-miss").addEventListener("click", () => addShot(false));
$("btn-undo").addEventListener("click", () => {
  const w = editor.work[editor.mode];
  if (w.shots.length) { w.shots.pop(); trimYashoGroups(editor.mode); renderEditor(); }
});

// 保存・削除のあとに全件を読み直すと、その読み込みが失敗しただけで
// 「保存に失敗しました」と出てしまう。手元のデータに直接反映して、
// 保存できたかどうかだけで判定する。
function upsertLocalPractice(saved) {
  const apply = (arr) => {
    const next = arr.filter((p) => p.id !== saved.id);
    next.push(saved);
    next.sort((a, b) => (a.date < b.date ? 1 : -1));
    return next;
  };
  state.myPractices = apply(state.myPractices);
  state.teamPractices = apply(state.teamPractices);
}
function removeLocalPractice(id) {
  state.myPractices = state.myPractices.filter((p) => p.id !== id);
  state.teamPractices = state.teamPractices.filter((p) => p.id !== id);
}

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
    upsertLocalPractice({ id: editor.practiceId, ...data });
    renderHome();
    showSummary(data);
    msg.textContent = "";
  } catch (e) {
    console.error(e);
    msg.textContent = `保存に失敗しました。もう一度試してください。（目印：${e?.code || "不明なエラー"}）`;
  }
});

$("btn-delete").addEventListener("click", async () => {
  if (!editor.practiceId) return;
  if (!window.confirm("この日の記録を削除します。よろしいですか？")) return;
  try {
    await removePractice(editor.practiceId);
    removeLocalPractice(editor.practiceId);
    resetEditor(editor.date);
    renderHome();
  } catch (e) {
    console.error(e);
    $("record-message").textContent = `削除に失敗しました。（目印：${e?.code || "不明なエラー"}）`;
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
// 矢所は、各立・射込みの横の「矢所」ボタンから、その立ぶんだけ入れる。
// ○×や何本目かを区別せず、外れも含めてまとめて的をタップして記録する。
// yashoTarget: { type, group } 編集中の立
let yashoTarget = null;

function groupLabel(type, group) {
  return `${TYPE_LABEL[type]} ${group + 1}`;
}

function setYashoButtons(mode) {
  // mode: "pad"（的の入力中）
  $("btn-yasho-pop").hidden = mode !== "pad";
  $("btn-yasho-clear").hidden = mode !== "pad";
}

function openYashoPanel(type, group) {
  yashoTarget = { type, group };
  renderYashoPad();
  setYashoButtons("pad");
  $("yasho-panel").hidden = false;
}

function renderYashoPad() {
  if (!yashoTarget) return;
  const { type, group } = yashoTarget;
  const w = editor.work[type];
  if (!w.yashoGroups[group]) w.yashoGroups[group] = [];
  const points = w.yashoGroups[group];
  const cap = groupShotCount(type, group);
  $("yasho-target-label").textContent =
    `${groupLabel(type, group)} の矢所：的をタップして ${cap} 本分まとめて入れてください。○×や何本目かの区別は不要です（いま ${points.length}／${cap} 点）。`;
  $("yasho-pad").innerHTML = targetPadSvg(points, true);
  const svg = $("yasho-svg");
  if (svg) {
    svg.addEventListener("click", (ev) => {
      if (points.length >= cap) return;
      const rect = svg.getBoundingClientRect();
      // 画面上のタップ位置 → 的の中心からの相対座標（-1〜1、右・下が正）
      const px = (ev.clientX - rect.left) / rect.width;   // 0〜1
      const py = (ev.clientY - rect.top) / rect.height;   // 0〜1
      let x = (px * 220 - 110) / 100;
      let y = (py * 220 - 110) / 100;
      x = Math.max(-1, Math.min(1, Math.round(x * 100) / 100));
      y = Math.max(-1, Math.min(1, Math.round(y * 100) / 100));
      points.push({ x, y });
      renderYashoPad();
      renderEditor();
    });
  }
}

function closeYashoPanel() {
  yashoTarget = null;
  $("yasho-panel").hidden = true;
}
$("btn-yasho-done").addEventListener("click", closeYashoPanel);
$("btn-yasho-pop").addEventListener("click", () => {
  if (!yashoTarget) return;
  const pts = editor.work[yashoTarget.type].yashoGroups[yashoTarget.group] || [];
  pts.pop();
  renderYashoPad();
  renderEditor();
});
$("btn-yasho-clear").addEventListener("click", () => {
  if (!yashoTarget) return;
  editor.work[yashoTarget.type].yashoGroups[yashoTarget.group] = [];
  renderYashoPad();
  renderEditor();
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
  renderAccount();
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
  $("team-total-breakdown").textContent =
    `立：${st.tachi.shots}射 ${st.tachi.hits}中（${rateText(st.tachi.shots, st.tachi.hits)}）／射込み：${st.shakomi.shots}射 ${st.shakomi.hits}中（${rateText(st.shakomi.shots, st.shakomi.hits)}）`;

  const wrap = $("team-members");
  wrap.innerHTML = "";
  $("team-members-heading").hidden = !isLeader;
  $("team-members-help").hidden = !isLeader;
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
        <span class="m-sub">${r.member.grade ? esc(r.member.grade) + " ／ " : ""}${r.member.id === state.user.uid ? "自分" : ""}</span><br>
        <span class="m-sub">立 ${rateText(r.st.tachi.shots, r.st.tachi.hits)} ／ 射込み ${rateText(r.st.shakomi.shots, r.st.shakomi.hits)}</span></span>
        <span>${r.st.shots}射 ${r.st.hits}中（${rateText(r.st.shots, r.st.hits)}）</span>`;
      b.addEventListener("click", () => renderMemberDetail(r.member.id));
      wrap.appendChild(b);
    }
    if (!rows.length) wrap.innerHTML = '<p class="empty">メンバーがいません。</p>';
  }
  // 一般メンバーには合計だけ（他人の詳細は出さない）
  $("btn-open-analysis").hidden = !isLeader;
  $("btn-open-my-analysis").hidden = isLeader;
  if (state.analysisOpen && (isLeader || state.analysisPersonal)) {
    $("member-detail-card").hidden = true;
    $("team-summary-card").hidden = true;
    $("analysis-card").hidden = false;
  } else if (state.detailUid && isLeader) {
    // 詳細は renderMemberDetail で表示済み
    $("analysis-card").hidden = true;
  } else {
    $("member-detail-card").hidden = true;
    $("team-summary-card").hidden = false;
    $("analysis-card").hidden = true;
  }

  // 記録の整理（リーダーのみ）：3年より前の記録の件数を出す
  $("cleanup-card").hidden = !isLeader;
  if (isLeader) {
    const old = oldPractices();
    $("cleanup-count").textContent = old.length
      ? `3年より前の記録が ${old.length} 件あります`
      : "3年より前の記録はありません";
    $("btn-cleanup").disabled = old.length === 0;
  }
}

// 記録の日から3年以上たった記録（整理の対象）
function oldPractices() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return state.teamPractices.filter((p) => p.date && p.date <= cutoff);
}

// ---------------- 分析シート（リーダー用） ----------------
// 期間（開始日〜終了日）と集計単位（日ごと／週ごと）を選んで、
// 複数メンバーの的中率の推移を重ねて比べ、矢所の集中も見る。
const ANALYSIS_COLORS = ["#c73e2c", "#2456a6", "#2e7d4f", "#7b4ba8", "#b7791f", "#00838f"];

function parseDateStr(s) {
  const [y, m, d] = String(s || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function addDaysStr(s, n) {
  const d = parseDateStr(s);
  if (!d) return s;
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}
function daysBetween(a, b) {
  const da = parseDateStr(a);
  const db = parseDateStr(b);
  if (!da || !db) return NaN;
  return Math.round((db - da) / 86400000);
}
function weekStartStr(s) {
  const d = parseDateStr(s);
  if (!d) return s;
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 月曜始まり
  return dateToStr(d);
}
function shortDate(s) {
  const p = String(s || "").split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : s;
}

// 記録の集まりから矢所の点を全部取り出す（新形式・旧形式の両対応）
function collectYashoPoints(list) {
  const points = [];
  for (const p of list) {
    for (const e of p.entries || []) {
      if (Array.isArray(e.yashoGroups)) {
        for (const g of e.yashoGroups) for (const pt of g || []) points.push(pt);
      } else {
        (e.shots || []).forEach((s, i) => {
          const y = e.yasho && e.yasho[i];
          if (y) points.push(y);
        });
      }
    }
  }
  return points;
}

function initAnalysis() {
  const today = todayStr();
  if (!state.analysisStart) state.analysisStart = addDaysStr(today, -29);
  if (!state.analysisEnd) state.analysisEnd = today;
  $("analysis-start").value = state.analysisStart;
  $("analysis-end").value = state.analysisEnd;
  if (state.analysisPersonal) {
    // 生徒用：比べるのは自分だけ
    state.analysisSelected = [state.user.uid];
    state.analysisInit = true;
    return;
  }
  if (!state.analysisInit) {
    const students = state.members.filter((m) => m.id !== state.user.uid);
    state.analysisSelected = (students.length ? students : state.members)
      .slice(0, 3)
      .map((m) => m.id);
    state.analysisInit = true;
  }
  const ids = state.members.map((m) => m.id);
  state.analysisSelected = state.analysisSelected.filter((id) => ids.includes(id));
}

$("btn-open-analysis").addEventListener("click", () => {
  if (state.profile?.role !== "leader") return;
  state.analysisPersonal = false;
  state.analysisOpen = true;
  state.detailUid = null;
  initAnalysis();
  $("analysis-title").textContent = "分析シート";
  $("analysis-note").textContent = "期間とメンバーを選んで、的中率の推移と矢所の集中を見ます（リーダー用）。";
  $("team-summary-card").hidden = true;
  $("member-detail-card").hidden = true;
  $("analysis-card").hidden = false;
  renderAnalysis();
});
$("btn-open-my-analysis").addEventListener("click", () => {
  if (!state.user) return;
  state.analysisPersonal = true;
  state.analysisOpen = true;
  state.detailUid = null;
  initAnalysis();
  $("analysis-title").textContent = "自分の分析";
  $("analysis-note").textContent = "自分の記録だけを表示します。期間と単位を選んで、的中率の推移と矢所の集中を見ます。";
  $("team-summary-card").hidden = true;
  $("member-detail-card").hidden = true;
  $("analysis-card").hidden = false;
  renderAnalysis();
});
$("btn-analysis-back").addEventListener("click", () => {
  state.analysisOpen = false;
  $("analysis-card").hidden = true;
  $("team-summary-card").hidden = false;
});
$("analysis-start").addEventListener("change", (ev) => {
  state.analysisStart = ev.target.value;
  renderAnalysis();
});
$("analysis-end").addEventListener("change", (ev) => {
  state.analysisEnd = ev.target.value;
  renderAnalysis();
});
document.querySelectorAll("[data-aunit]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.analysisUnit = btn.dataset.aunit;
    document.querySelectorAll("[data-aunit]").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderAnalysis();
  });
});
document.querySelectorAll("[data-aperiod]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const today = todayStr();
    const kind = btn.dataset.aperiod;
    if (kind === "30days") {
      state.analysisStart = addDaysStr(today, -29);
      state.analysisEnd = today;
    } else if (kind === "month") {
      state.analysisStart = `${monthStr(0)}-01`;
      state.analysisEnd = today;
    } else if (kind === "lastMonth") {
      const ms = monthStr(-1);
      const [y, m] = ms.split("-").map(Number);
      const last = new Date(y, m, 0).getDate();
      state.analysisStart = `${ms}-01`;
      state.analysisEnd = `${ms}-${String(last).padStart(2, "0")}`;
    } else if (kind === "total") {
      const dates = state.teamPractices.map((p) => p.date).filter(Boolean).sort();
      state.analysisStart = dates.length ? dates[0] : `${monthStr(0)}-01`;
      state.analysisEnd = today;
    }
    $("analysis-start").value = state.analysisStart;
    $("analysis-end").value = state.analysisEnd;
    renderAnalysis();
  });
});

function renderAnalysisMembers() {
  const wrap = $("analysis-members");
  wrap.innerHTML = "";
  if (state.analysisPersonal) {
    // 生徒用ではメンバー選択を出さない
    wrap.hidden = true;
    $("analysis-members-heading").hidden = true;
    return;
  }
  wrap.hidden = false;
  $("analysis-members-heading").hidden = false;
  const selectedIndex = new Map(state.analysisSelected.map((id, i) => [id, i]));
  for (const m of state.members) {
    const idx = selectedIndex.get(m.id);
    const label = document.createElement("label");
    label.className = "analysis-member-check";
    label.innerHTML = `
      <input type="checkbox" ${idx !== undefined ? "checked" : ""}>
      <span class="color-dot" style="background:${idx !== undefined ? ANALYSIS_COLORS[idx % ANALYSIS_COLORS.length] : "#d8d2c4"}"></span>
      <span>${esc(m.name)}${m.grade ? `（${esc(m.grade)}）` : ""}${m.id === state.user.uid ? "（自分）" : ""}</span>`;
    label.querySelector("input").addEventListener("change", (ev) => {
      const msg = $("analysis-message");
      if (ev.target.checked) {
        if (state.analysisSelected.length >= ANALYSIS_COLORS.length) {
          ev.target.checked = false;
          msg.textContent = "比べられるのは6人までです。";
          return;
        }
        state.analysisSelected.push(m.id);
      } else {
        state.analysisSelected = state.analysisSelected.filter((id) => id !== m.id);
      }
      msg.textContent = "";
      renderAnalysis();
    });
    wrap.appendChild(label);
  }
}

function analysisBuckets(start, end, unit) {
  const buckets = [];
  if (unit === "day") {
    for (let cur = start; daysBetween(cur, end) >= 0; cur = addDaysStr(cur, 1)) {
      buckets.push({ key: cur, label: shortDate(cur) });
      if (buckets.length > 400) break;
    }
  } else {
    for (let cur = weekStartStr(start); daysBetween(cur, end) >= 0; cur = addDaysStr(cur, 7)) {
      buckets.push({ key: cur, label: `${shortDate(cur)}の週` });
      if (buckets.length > 120) break;
    }
  }
  return buckets;
}

function buildAnalysisSeries() {
  const start = state.analysisStart;
  const end = state.analysisEnd;
  const unit = state.analysisUnit;
  const buckets = analysisBuckets(start, end, unit);
  return state.analysisSelected
    .map((uid, i) => {
      const member = state.members.find((m) => m.id === uid);
      if (!member) return null;
      const list = state.teamPractices.filter(
        (p) => p.uid === uid && p.date >= start && p.date <= end
      );
      const byKey = new Map(buckets.map((b) => [b.key, { ...b, shots: 0, hits: 0 }]));
      for (const p of list) {
        const key = unit === "day" ? p.date : weekStartStr(p.date);
        const b = byKey.get(key);
        if (!b) continue;
        const st = practiceStats(p);
        b.shots += st.shots;
        b.hits += st.hits;
      }
      const agg = [...byKey.values()].map((b) => ({
        ...b,
        rate: b.shots ? b.hits / b.shots : null
      }));
      return {
        member,
        uid,
        color: ANALYSIS_COLORS[i % ANALYSIS_COLORS.length],
        list,
        buckets: agg,
        total: sumStats(list),
        points: collectYashoPoints(list)
      };
    })
    .filter(Boolean);
}

function trendChartSvg(series, buckets) {
  const W = 760, H = 340, L = 48, R = 16, T = 16, B = 54;
  const pw = W - L - R;
  const ph = H - T - B;
  const x = (i) => (buckets.length === 1 ? L + pw / 2 : L + (pw * i) / (buckets.length - 1));
  const y = (rate) => T + (1 - rate) * ph;
  let g = "";
  for (const gv of [0, 0.25, 0.5, 0.75, 1]) {
    const gy = y(gv);
    g += `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="#e3ddcf" stroke-width="1"/>` +
      `<text x="${L - 6}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#6f6a5e">${Math.round(gv * 100)}%</text>`;
  }
  const step = Math.max(1, Math.ceil(buckets.length / 10));
  const crowded = buckets.length > 12;
  buckets.forEach((b, i) => {
    if (i % step !== 0 && i !== buckets.length - 1) return;
    const lx = x(i);
    const rotate = crowded ? ` transform="rotate(-30 ${lx} ${H - B + 8})"` : "";
    g += `<text x="${lx}" y="${H - B + 18}" text-anchor="${crowded ? "end" : "middle"}" font-size="11" fill="#6f6a5e"${rotate}>${esc(b.label)}</text>`;
  });
  for (const s of series) {
    // 記録のない区間（休みなど）があっても、線は途切れずに前後をつなぐ
    const pts = [];
    s.buckets.forEach((b, i) => {
      if (b.rate !== null) pts.push([x(i), y(b.rate)]);
    });
    if (pts.length > 1) {
      g += `<path d="${pts.map((pt, j) => `${j ? "L" : "M"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    s.buckets.forEach((b, i) => {
      if (b.rate === null) return;
      g += `<circle cx="${x(i)}" cy="${y(b.rate)}" r="4" fill="${s.color}" stroke="#fff" stroke-width="1.5"><title>${esc(s.member.name)}：${esc(b.label)} ${b.shots}射 ${b.hits}中（${Math.round(b.rate * 100)}%）</title></circle>`;
    });
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="的中率の推移グラフ">${g}</svg>`;
}

function volatilityOf(rates) {
  if (!rates.length) {
    return { max: null, min: null, range: null, sd: null, label: "記録がありません" };
  }
  const max = Math.round(Math.max(...rates) * 100);
  const min = Math.round(Math.min(...rates) * 100);
  if (rates.length < 2) {
    return { max, min, range: null, sd: null, label: "区間が1つだけです" };
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.round(
    Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length) * 100
  );
  return {
    max,
    min,
    range: max - min,
    sd,
    label: sd >= 20 ? "波が大きい" : sd >= 10 ? "やや波がある" : "安定している"
  };
}

function analysisTrendTable(series) {
  if (!series.length) return "";
  const rows = series.map((s) => {
    const active = s.buckets.filter((b) => b.rate !== null);
    const v = volatilityOf(active.map((b) => b.rate));
    return `<tr>
      <td><span class="color-dot" style="background:${s.color}"></span> ${esc(s.member.name)}</td>
      <td>${s.total.shots}射</td>
      <td>${s.total.hits}中</td>
      <td>${rateText(s.total.shots, s.total.hits)}</td>
      <td>${rateText(s.total.tachi.shots, s.total.tachi.hits)}</td>
      <td>${rateText(s.total.shakomi.shots, s.total.shakomi.hits)}</td>
      <td>${v.max != null ? v.max + "%" : "―"}</td>
      <td>${v.min != null ? v.min + "%" : "―"}</td>
      <td>${v.range != null ? v.range + "ポイント" : "―"}</td>
      <td>${v.sd != null ? v.sd + "ポイント" : "―"}</td>
      <td>${esc(v.label)}（${active.length}区間）</td>
    </tr>`;
  }).join("");
  return `<div class="analysis-table-wrap"><table class="analysis-table">
    <thead><tr><th>メンバー</th><th>射数</th><th>的中</th><th>的中率</th><th>立</th><th>射込み</th><th>最高</th><th>最低</th><th>変動幅</th><th>ばらつき</th><th>波の目安</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function analysisYashoSvg(series) {
  const dots = [];
  const centers = [];
  for (const s of series) {
    for (const pt of s.points) {
      dots.push(`<circle cx="${(110 + pt.x * 100).toFixed(1)}" cy="${(110 + pt.y * 100).toFixed(1)}" r="4.2" fill="${s.color}" fill-opacity="0.65" stroke="#fff" stroke-width="1"/>`);
    }
    if (s.points.length) {
      const mx = s.points.reduce((a, p) => a + p.x, 0) / s.points.length;
      const my = s.points.reduce((a, p) => a + p.y, 0) / s.points.length;
      const cx = 110 + mx * 100;
      const cy = 110 + my * 100;
      const cross = `M ${(cx - 9).toFixed(1)} ${cy.toFixed(1)} H ${(cx + 9).toFixed(1)} M ${cx.toFixed(1)} ${(cy - 9).toFixed(1)} V ${(cy + 9).toFixed(1)}`;
      centers.push(
        `<path d="${cross}" stroke="#fff" stroke-width="5" stroke-linecap="round"/>` +
        `<path d="${cross}" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round"/>`
      );
    }
  }
  return `<svg viewBox="0 0 220 220" role="img" aria-label="矢所の集中">
    <circle cx="110" cy="110" r="104" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="84.9" fill="#fffdf7"/>
    <circle cx="110" cy="110" r="67.6" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="58.9" fill="#fffdf7"/>
    <circle cx="110" cy="110" r="41.6" fill="#2b2b28"/>
    <circle cx="110" cy="110" r="20.8" fill="#fffdf7"/>
    ${dots.join("")}${centers.join("")}
  </svg>`;
}

// 矢所の集中のしかた（座標は的の半径=1.04に換算し、cmは半径18cmで計算）
function yashoMetrics(points) {
  if (!points.length) return null;
  const R = 1.04;
  const norm = points.map((p) => ({ nx: p.x / R, ny: p.y / R }));
  const n = norm.length;
  const mx = norm.reduce((a, q) => a + q.nx, 0) / n;
  const my = norm.reduce((a, q) => a + q.ny, 0) / n;
  const meanDistCm = (norm.reduce((a, q) => a + Math.hypot(q.nx, q.ny), 0) / n) * 18;
  const spreadCm = Math.sqrt(
    norm.reduce((a, q) => a + (q.nx - mx) ** 2 + (q.ny - my) ** 2, 0) / n
  ) * 18;
  const centerPct = Math.round((norm.filter((q) => Math.hypot(q.nx, q.ny) <= 0.2).length / n) * 100);
  const inPct = Math.round((norm.filter((q) => Math.hypot(q.nx, q.ny) <= 1).length / n) * 100);
  const cxCm = mx * 18;
  const cyCm = my * 18;
  const parts = [];
  if (cxCm >= 1) parts.push("右");
  else if (cxCm <= -1) parts.push("左");
  if (cyCm >= 1) parts.push("下");
  else if (cyCm <= -1) parts.push("上");
  const centroid = parts.length ? parts.join("") + "寄り" : "ほぼ中心";
  const cells = new Map();
  for (const q of norm) {
    const col = q.nx < -1 / 3 ? 0 : q.nx > 1 / 3 ? 2 : 1;
    const row = q.ny < -1 / 3 ? 0 : q.ny > 1 / 3 ? 2 : 1;
    const key = `${col},${row}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  let bestKey = "1,1";
  let bestCount = -1;
  for (const [key, count] of cells) {
    if (count > bestCount) { bestKey = key; bestCount = count; }
  }
  const [bc, br] = bestKey.split(",").map(Number);
  const colL = ["左", "中央", "右"][bc];
  const rowL = ["上", "中央", "下"][br];
  const area = bc === 1 && br === 1 ? "中央"
    : br === 1 ? `${colL}寄り`
    : bc === 1 ? `${rowL}寄り`
    : `${colL}${rowL}`;
  return {
    count: n,
    area,
    areaPct: Math.round((bestCount / n) * 100),
    meanDistCm: meanDistCm.toFixed(1),
    centerPct,
    inPct,
    centroid,
    spreadCm: spreadCm.toFixed(1),
    spreadLabel: spreadCm <= 4 ? "よく集中" : spreadCm <= 7 ? "やや集中" : "広がりあり"
  };
}

function analysisYashoTable(series) {
  if (!series.length) return "";
  const rows = series.map((s) => {
    const mt = yashoMetrics(s.points);
    if (!mt) {
      return `<tr>
        <td><span class="color-dot" style="background:${s.color}"></span> ${esc(s.member.name)}</td>
        <td>0点</td><td>―</td><td>―</td><td>―</td><td>―</td><td>―</td><td>―</td><td>記録なし</td>
      </tr>`;
    }
    return `<tr>
      <td><span class="color-dot" style="background:${s.color}"></span> ${esc(s.member.name)}</td>
      <td>${mt.count}点</td>
      <td>${esc(mt.area)}</td>
      <td>${mt.areaPct}%</td>
      <td>${mt.meanDistCm}cm</td>
      <td>${mt.centerPct}%</td>
      <td>${mt.inPct}%</td>
      <td>${esc(mt.centroid)}</td>
      <td>${esc(mt.spreadLabel)}（${mt.spreadCm}cm）</td>
    </tr>`;
  }).join("");
  return `<div class="analysis-table-wrap"><table class="analysis-table">
    <thead><tr><th>メンバー</th><th>矢所</th><th>多い場所</th><th>その割合</th><th>中心からの平均</th><th>中白圏</th><th>的内</th><th>重心</th><th>広がり</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderAnalysis() {
  if (state.profile?.role !== "leader" && !state.analysisPersonal) return;
  const msg = $("analysis-message");
  renderAnalysisMembers();
  const start = state.analysisStart;
  const end = state.analysisEnd;
  const clear = () => {
    $("analysis-legend").innerHTML = "";
    $("analysis-chart").innerHTML = "";
    $("analysis-trend-table").innerHTML = "";
    $("analysis-yasho").innerHTML = "";
    $("analysis-yasho-table").innerHTML = "";
  };
  if (!start || !end || !(daysBetween(start, end) >= 0)) {
    msg.textContent = "期間を確認してください（開始日が終了日より後になっています）。";
    clear();
    return;
  }
  if (daysBetween(start, end) > 366) {
    msg.textContent = "期間は1年以内で選んでください。";
    clear();
    return;
  }
  msg.textContent = state.analysisSelected.length ? "" : "比べるメンバーを選んでください。";
  const series = buildAnalysisSeries();
  const buckets = analysisBuckets(start, end, state.analysisUnit);
  $("analysis-legend").innerHTML = series.map((s) =>
    `<span class="legend-item"><span class="color-dot" style="background:${s.color}"></span>${esc(s.member.name)}（${rateText(s.total.shots, s.total.hits)}）</span>`
  ).join("");
  const hasData = series.some((s) => s.buckets.some((b) => b.rate !== null));
  $("analysis-chart").innerHTML = series.length && hasData
    ? trendChartSvg(series, buckets)
    : '<p class="empty">選択した期間に記録がありません。</p>';
  $("analysis-trend-table").innerHTML = analysisTrendTable(series);
  const hasPoints = series.some((s) => s.points.length);
  $("analysis-yasho").innerHTML = series.length && hasPoints
    ? analysisYashoSvg(series)
    : '<p class="empty">選択した期間に矢所の記録がありません。</p>';
  $("analysis-yasho-table").innerHTML = analysisYashoTable(series);
}

$("btn-cleanup").addEventListener("click", async () => {
  const targets = oldPractices();
  if (!targets.length) return;
  if (!window.confirm(`3年より前の記録 ${targets.length} 件を削除します。削除した記録は元に戻せません。よろしいですか？`)) return;
  const btn = $("btn-cleanup");
  const msg = $("cleanup-message");
  btn.disabled = true;
  try {
    await deletePractices(targets.map((p) => p.id));
    await refreshData();
    renderTeam();
    const msg2 = $("cleanup-message");
    msg2.textContent = `${targets.length} 件の記録を削除しました。`;
    msg2.classList.add("ok");
  } catch (e) {
    console.error(e);
    msg.textContent = "削除に失敗しました。通信環境を確認してもう一度お試しください。";
    msg.classList.remove("ok");
    btn.disabled = false;
  }
});

function renderMemberDetail(uid) {
  if (state.profile.role !== "leader") return;
  state.detailUid = uid;
  const range = state.teamRange;
  const list = state.teamPractices.filter((p) => p.uid === uid && inRange(p.date, range));
  const st = sumStats(list);
  const detailMember = state.members.find((x) => x.id === uid);
  $("detail-name").textContent = detailMember?.grade
    ? `${memberName(uid)}（${detailMember.grade}）さんの記録`
    : `${memberName(uid)} さんの記録`;
  $("detail-summary").textContent =
    `${range === "month" ? "今月" : "通算"}：${st.shots}射 ${st.hits}中（的中率 ${rateText(st.shots, st.hits)}）`;
  $("detail-breakdown").textContent =
    `立：${st.tachi.shots}射 ${st.tachi.hits}中（${rateText(st.tachi.shots, st.tachi.hits)}）／射込み：${st.shakomi.shots}射 ${st.shakomi.hits}中（${rateText(st.shakomi.shots, st.shakomi.hits)}）`;

  // 矢所の散布図（期間内の全記録ぶん。○×は区別せず全部の点）
  const points = [];
  for (const p of list) {
    for (const e of p.entries || []) {
      if (Array.isArray(e.yashoGroups)) {
        for (const g of e.yashoGroups) for (const pt of g || []) points.push(pt);
      } else {
        // 旧形式（1射ごとの矢所）で保存された記録
        (e.shots || []).forEach((s, i) => {
          const y = e.yasho && e.yasho[i];
          if (y) points.push(y);
        });
      }
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

  // リーダーが他のメンバーを見ているときだけ管理欄を出す
  const target = state.members.find((m) => m.id === uid);
  const canManage = state.profile?.role === "leader" && uid !== state.user.uid;
  $("detail-manage").hidden = !canManage;
  if (canManage && target) {
    $("detail-edit-name").value = target.name || "";
    $("detail-edit-grade").value = target.grade || "";
    $("detail-manage-message").textContent = "";
    $("detail-manage-message").classList.remove("ok");
    // 記録の引き継ぎ先の候補（このメンバー以外）
    const sel = $("detail-transfer-to");
    sel.innerHTML = "";
    for (const m of state.members) {
      if (m.id === uid) continue;
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.grade ? `${m.name || "（名前未設定）"}（${m.grade}）` : (m.name || "（名前未設定）");
      sel.appendChild(opt);
    }
    $("detail-transfer-wrap").hidden = state.members.length <= 1;
  }

  state.analysisOpen = false;
  $("analysis-card").hidden = true;
  $("team-summary-card").hidden = true;
  $("member-detail-card").hidden = false;
}
$("btn-detail-back").addEventListener("click", () => {
  state.detailUid = null;
  $("member-detail-card").hidden = true;
  $("analysis-card").hidden = true;
  $("team-summary-card").hidden = false;
});

// リーダーがメンバーの名前・学年を直す
$("btn-detail-save").addEventListener("click", async () => {
  const uid = state.detailUid;
  if (!uid) return;
  const name = $("detail-edit-name").value.trim();
  const grade = $("detail-edit-grade").value.trim();
  const msg = $("detail-manage-message");
  if (!name) {
    msg.textContent = "名前を入力してください。";
    msg.classList.remove("ok");
    return;
  }
  try {
    await updateMemberProfile(uid, { name, grade: grade || null });
    await refreshData();
    renderMemberDetail(uid);
    const msg2 = $("detail-manage-message");
    msg2.textContent = "保存しました。";
    msg2.classList.add("ok");
  } catch (e) {
    console.error(e);
    msg.textContent = "保存に失敗しました。通信環境を確認してください。";
    msg.classList.remove("ok");
  }
});

// 引き継ぎの確認画面に出す、名前＋学年の表示
function memberLabel(uid) {
  const m = state.members.find((x) => x.id === uid);
  if (!m) return "（不明）";
  return m.grade ? `${m.name}（${m.grade}）` : m.name;
}

// リーダーがメンバーの記録を別メンバーへ引き継ぐ（まず最終確認画面を出す）
$("btn-detail-transfer").addEventListener("click", () => {
  const fromUid = state.detailUid;
  const toUid = $("detail-transfer-to").value;
  const msg = $("detail-manage-message");
  if (!fromUid || !toUid || fromUid === toUid) return;
  const list = state.teamPractices.filter((p) => p.uid === fromUid);
  if (!list.length) {
    msg.textContent = "引き継ぐ記録がありません。";
    msg.classList.remove("ok");
    return;
  }
  const dates = list.map((p) => p.date).filter(Boolean).sort();
  state.pendingTransfer = { fromUid, toUid, count: list.length };
  $("transfer-from").textContent = memberLabel(fromUid);
  $("transfer-to").textContent = memberLabel(toUid);
  $("transfer-count").textContent = `${list.length}件`;
  $("transfer-period").textContent = dates.length ? `${dates[0]} ～ ${dates[dates.length - 1]}` : "―";
  $("transfer-panel").hidden = false;
});

$("btn-transfer-cancel").addEventListener("click", () => {
  state.pendingTransfer = null;
  $("transfer-panel").hidden = true;
});

$("btn-transfer-confirm").addEventListener("click", async () => {
  const pending = state.pendingTransfer;
  const msg = $("detail-manage-message");
  if (!pending) return;
  const { fromUid, toUid, count } = pending;
  // 確認画面を開いてから記録が変わっていたら、間違いを防ぐため実行しない
  const currentCount = state.teamPractices.filter((p) => p.uid === fromUid).length;
  if (currentCount !== count) {
    state.pendingTransfer = null;
    $("transfer-panel").hidden = true;
    msg.textContent = "記録の件数が変わっています。もう一度、引き継ぎ先を確認してください。";
    msg.classList.remove("ok");
    return;
  }
  $("btn-transfer-confirm").disabled = true;
  $("btn-transfer-cancel").disabled = true;
  try {
    const moved = await transferPractices(fromUid, toUid);
    state.pendingTransfer = null;
    $("transfer-panel").hidden = true;
    await refreshData();
    renderMemberDetail(fromUid);
    const msg2 = $("detail-manage-message");
    msg2.textContent = `${moved}件の記録を引き継ぎました。`;
    msg2.classList.add("ok");
  } catch (e) {
    console.error(e);
    $("transfer-panel").hidden = true;
    msg.textContent = "引き継ぎに失敗しました。通信環境を確認してください。";
    msg.classList.remove("ok");
  } finally {
    $("btn-transfer-confirm").disabled = false;
    $("btn-transfer-cancel").disabled = false;
  }
});

// リーダーがメンバーをチームから外す（アカウントと過去の記録は残る）
$("btn-detail-remove").addEventListener("click", async () => {
  const uid = state.detailUid;
  if (!uid) return;
  if (!window.confirm(`${memberName(uid)} さんをチームから外します。よろしいですか？`)) return;
  try {
    await removeMemberFromTeam(uid);
    state.detailUid = null;
    await refreshData();
    renderTeam();
  } catch (e) {
    console.error(e);
    const msg = $("detail-manage-message");
    msg.textContent = "外せませんでした。通信環境を確認してください。";
    msg.classList.remove("ok");
  }
});

// ---------------- ログインIDとパスワード ----------------
// ログインIDは登録時に決めたものを使う（変更はできない）。
// ここではパスワードの変更だけを行う。
function renderAccount() {
  $("account-current-id").textContent = state.profile?.loginId || "未設定";
}

$("account-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("account-message");
  const password = $("account-password").value;
  if (!password) {
    msg.textContent = "新しいパスワードを入力してください。";
    msg.classList.remove("ok");
    return;
  }
  if (password.length < 6) {
    msg.textContent = "パスワードは6文字以上で入力してください。";
    msg.classList.remove("ok");
    return;
  }
  try {
    await setAccountPassword(state.user, password);
    $("account-password").value = "";
    msg.textContent = "パスワードを変更しました。";
    msg.classList.add("ok");
  } catch (e) {
    console.error(e);
    msg.classList.remove("ok");
    if (e.code === "auth/requires-recent-login") {
      msg.textContent = "安全のため、一度ログアウトしてログインし直してから変更してください。";
    } else {
      msg.textContent = "変更に失敗しました。通信環境を確認してもう一度お試しください。";
    }
  }
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
