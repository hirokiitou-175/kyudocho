// 弓道帳 — Firebase 接続（Auth：メールリンク方式 / Firestore）
// SDK は Firebase 公式の CDN から ES モジュールで読み込む（ビルド不要）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

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

export async function savePractice(practiceId, data) {
  if (practiceId) {
    await updateDoc(doc(db, "practices", practiceId), { ...data, updatedAt: serverTimestamp() });
    return practiceId;
  }
  const ref = await addDoc(collection(db, "practices"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}

export async function removePractice(practiceId) {
  await deleteDoc(doc(db, "practices", practiceId));
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
