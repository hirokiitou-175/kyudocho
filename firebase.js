// 弓道帳 — Firebase 接続（Auth：メールリンク方式 / Firestore）
// SDK は Firebase 公式の CDN から ES モジュールで読み込む（ビルド不要）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  linkWithCredential,
  updatePassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=20251105-31";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// オフライン保存：接続が一時的に切れても、書き込みは端末内に保管され、
// つながり直したときに自動で送信される（学校のWi-Fiなどで保存だけ失敗する対策）。
// 端末側の保存が使えない環境では、通常の接続方式に切り替える。
let dbInstance;
try {
  dbInstance = initializeFirestore(app, { localCache: persistentLocalCache() });
} catch (e) {
  dbInstance = getFirestore(app);
}
export const db = dbInstance;

// ---------- メールリンク ログイン ----------

const EMAIL_KEY = "kyudochoEmailForSignIn";

// メールアドレス宛にログイン用リンクを送る。
// url は現在のページ（Netlify の URL）。Firebase の「承認済みドメイン」に
// そのドメインが入っていないと送信できないので、公開後に追加が必要。
export async function sendLoginLink(email) {
  const actionCodeSettings = {
    url: window.location.origin + window.location.pathname,
    handleCodeInApp: true
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem(EMAIL_KEY, email);
}

// 現在の URL がログインリンクかどうか。
export function isEmailLink(url) {
  return isSignInWithEmailLink(auth, url);
}

// リンク送信時に保存したメールアドレス（このブラウザに残っている場合のみ）。
// 別ブラウザ・別アプリでリンクを開くと残っていないので、その場合は null。
export function savedSignInEmail() {
  return window.localStorage.getItem(EMAIL_KEY);
}

// ログインリンクから戻ってきたときのログイン完了処理。
// メールアドレスは送信時に保存したものを優先し、無い場合（別端末で開いた等）は askEmail で尋ねる。
export async function completeEmailLink(url, askEmail) {
  let email = window.localStorage.getItem(EMAIL_KEY);
  if (!email && askEmail) email = askEmail();
  if (!email) throw new Error("メールアドレスが分かりませんでした。リンクを送ったときと同じアドレスを入力してください。");
  const result = await signInWithEmailLink(auth, email, url);
  window.localStorage.removeItem(EMAIL_KEY);
  return result.user;
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

// ---------- ログインID＋パスワード ----------
// パスワード自体は Firebase Auth が保管する。
// Firebase のログインにはメールアドレス形式のIDが必要なため、新規登録では
// ログインIDから内部専用のダミー文字列（pseudoEmailFor）を自動生成して使う。
// 実際のメールアドレスは登録・保存せず、メールが送られることもない。
// （2026-11-05より前にメールアドレスで登録したアカウントは、そのまま使える。）
// ログインIDは usernames/{loginId} に { uid, email } を置き、
// ログイン時に ID → 内部ID → パスワードでログイン、の順に解決する。

// ログインIDから内部専用のダミー文字列を作る（IDの文字を16進数に変換したもの）
export function pseudoEmailFor(loginId) {
  const bytes = new TextEncoder().encode(loginId);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}@kyudocho.local`;
}

export async function findEmailByLoginId(loginId) {
  const snap = await getDoc(doc(db, "usernames", loginId));
  return snap.exists() ? snap.data().email : null;
}

// 内部IDとパスワードで新規アカウントを作る（登録フォーム用）
export async function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

// 作ったばかりの自分のアカウントを取り消す（登録の巻き戻し用）
export async function deleteCurrentUser(user) {
  await deleteUser(user);
}

// リーダーがメンバーの名前・学年を直す（ルール側で変更範囲を制限）
export async function updateMemberProfile(uid, data) {
  await updateDoc(doc(db, "users", uid), { ...data, updatedAt: serverTimestamp() });
}

// リーダーがメンバーをチームから外す（アカウント自体は残る）
export async function removeMemberFromTeam(uid) {
  await updateDoc(doc(db, "users", uid), {
    teamId: null,
    role: null,
    updatedAt: serverTimestamp()
  });
}

export async function signInWithId(loginId, password) {
  const email = await findEmailByLoginId(loginId);
  if (!email) {
    const e = new Error("そのログインIDは見つかりませんでした。");
    e.code = "app/id-not-found";
    throw e;
  }
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

// そのログインIDが既に使われているか（自分のものなら false）
export async function isLoginIdTaken(loginId, myUid) {
  const snap = await getDoc(doc(db, "usernames", loginId));
  return snap.exists() && snap.data().uid !== myUid;
}

// ログインIDを自分のものとして登録する。他人が使用中なら例外。
export async function claimLoginId(loginId, uid, email) {
  const ref = doc(db, "usernames", loginId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    if (snap.data().uid === uid) return;
    const e = new Error("そのログインIDは既に使われています。");
    e.code = "app/id-taken";
    throw e;
  }
  await setDoc(ref, { uid, email, createdAt: serverTimestamp() });
}

export async function releaseLoginId(loginId) {
  await deleteDoc(doc(db, "usernames", loginId));
}

export function hasPasswordProvider(user) {
  return (user?.providerData || []).some((p) => p.providerId === "password");
}

// アカウントにパスワードを設定する（未設定なら追加、設定済みなら変更）。
export async function setAccountPassword(user, password) {
  if (hasPasswordProvider(user)) {
    await updatePassword(user, password);
  } else {
    const cred = EmailAuthProvider.credential(user.email, password);
    await linkWithCredential(user, cred);
  }
}

export function logout() {
  return signOut(auth);
}

// ---------- Firestore ヘルパー ----------

export { serverTimestamp };

// users/{uid}
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function saveUserProfile(uid, data) {
  await setDoc(doc(db, "users", uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

// teams
export async function createTeam(name, leaderUid) {
  const inviteCode = makeInviteCode();
  const ref = await addDoc(collection(db, "teams"), {
    name,
    inviteCode,
    leaderUid,
    createdAt: serverTimestamp()
  });
  return { id: ref.id, name, inviteCode, leaderUid };
}

export async function findTeamByInviteCode(code) {
  const q = query(collection(db, "teams"), where("inviteCode", "==", code));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export async function getTeam(teamId) {
  const snap = await getDoc(doc(db, "teams", teamId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// 同じチームのメンバー（users を teamId で引く）
export async function listTeamMembers(teamId) {
  const q = query(collection(db, "users"), where("teamId", "==", teamId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// practices
export async function listPracticesByUser(uid) {
  const q = query(collection(db, "practices"), where("uid", "==", uid));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function listPracticesByTeam(teamId) {
  const q = query(collection(db, "practices"), where("teamId", "==", teamId));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// 記録の日から3年後の日時。Firestore の「有効期限（TTL）」設定と組み合わせて、
// 3年たった記録が自動で消えるようにする（Firebase 側で practices コレクションの
// expireAt フィールドに TTL を有効化しておくこと）。
function expireAtFor(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + 3);
  return d;
}

// 書き込みの完了を待つ方針（電波の悪い場所向け）：
// サーバー到着の確認は最大で数秒だけ待ち、間に合わなければ「端末に保存済み（送信待ち）」として返す。
// 端末内のキューに入った書き込みは、接続が戻ったときに自動で送信される。
// 明らかな失敗（権限エラーなど、すぐに返ってくるもの）はそのまま throw する。
export function settleWrite(promise, ms = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      promise.catch((e) => console.error("送信待ちの書き込みが最終的に失敗しました:", e));
      resolve("queued");
    }, ms);
    promise.then(
      () => { if (!done) { done = true; clearTimeout(timer); resolve("ok"); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

// 保存は { id, settled } を返す。id は書き込み開始の時点で決まる。
// settled は "ok"（サーバー到着を確認）か "queued"（端末に保存済み・送信待ち）で解決する。
export function savePractice(practiceId, data) {
  const expireAt = data && data.date ? expireAtFor(data.date) : null;
  const extra = expireAt ? { expireAt } : {};
  if (practiceId) {
    const settled = settleWrite(updateDoc(doc(db, "practices", practiceId), { ...data, ...extra, updatedAt: serverTimestamp() }));
    return { id: practiceId, settled };
  }
  const ref = doc(collection(db, "practices"));
  const settled = settleWrite(setDoc(ref, {
    ...data,
    ...extra,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }));
  return { id: ref.id, settled };
}

// 複数の記録をまとめて削除する（古い記録の整理用。1回400件ずつ）
export async function deletePractices(ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) {
      batch.delete(doc(db, "practices", id));
    }
    await batch.commit();
  }
}

export function removePractice(practiceId) {
  return settleWrite(deleteDoc(doc(db, "practices", practiceId)));
}

// サーバー上の記録を、端末内の控えではなく直接確認する（送信箱の照合用）。
// 通信できないときは例外になるので、呼び出し側で「確認できなかった」として扱う。
export async function fetchPracticeFromServer(practiceId) {
  const snap = await getDocFromServer(doc(db, "practices", practiceId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// 送信箱に残っていた記録を、同じIDで送り直す（届いていなければ新規、届いていれば上書き。
// IDが同じなので二重にはならない）。settleWrite で包んで { settled } 形式に合わせる。
export function resendPractice(practiceId, data) {
  const expireAt = data && data.date ? expireAtFor(data.date) : null;
  const extra = expireAt ? { expireAt } : {};
  const settled = settleWrite(setDoc(doc(db, "practices", practiceId), {
    ...data,
    ...extra,
    updatedAt: serverTimestamp()
  }, { merge: true }));
  return { id: practiceId, settled };
}

// 自分の記録に「サーバー未到着の書き込み」があるかを監視する。
// callback(true) = 送信待ちあり。戻り値は監視を止める関数。
export function watchMyPendingWrites(uid, callback) {
  const q = query(collection(db, "practices"), where("uid", "==", uid));
  return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    callback(snap.metadata.hasPendingWrites);
  }, (e) => console.error(e));
}

// リーダーがメンバーの記録を別メンバーへ引き継ぐ（記録の持ち主 uid を付け替える。1回400件ずつ）
export async function transferPractices(fromUid, toUid) {
  const q = query(collection(db, "practices"), where("uid", "==", fromUid));
  const snap = await getDocs(q);
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + 400)) {
      batch.update(d.ref, { uid: toUid });
    }
    await batch.commit();
  }
  return docs.length;
}

// 招待コード（読み間違いしやすい文字を避けた6文字）
function makeInviteCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) code += chars[buf[i] % chars.length];
  return code;
}
