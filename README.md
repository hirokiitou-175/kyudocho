# 弓道帳（チーム版）

弓道の的中記録アプリ。ビルド不要の静的 Web アプリで、Firebase（Auth＋Firestore）を使う。

## ファイル構成
- `index.html`：単一ページアプリの土台
- `styles.css`：和風ミニマルのデザイン（白・生成り、墨色、朱色、的モチーフ）
- `app.js`：画面と処理すべて（ログイン、プロフィール、チーム、記録、集計、CSV）
- `firebase.js`：Firebase の初期化と読み書きヘルパー（SDK は公式 CDN から ES モジュールで読込）
- `firebase-config.js`：接続情報（公開前提の識別情報。アクセス制限は Firestore ルール側）
- `firestore.rules`：Firestore セキュリティルール
- `manifest.webmanifest` / `icon.svg`：ホーム画面追加用
- `netlify.toml`：Netlify 設定（ルートをそのまま公開）

## データ構造（Firestore）
- `users/{uid}`：name、grade（任意）、teamId、role（leader/member）、email
- `teams/{teamId}`：name、inviteCode、leaderUid
- `practices/{id}`：uid、teamId、date（YYYY-MM-DD）、entries（形式ごとの shots ○×配列と yasho 座標配列）、memo、incomplete

## デプロイ手順
1. GitHub リポジトリ（`kyudocho`、Private）にこの一式を置く
2. Netlify でリポジトリをつなぎ公開（ビルドコマンドなし、公開フォルダはルート）
3. Firebase コンソールで用意するもの
   - Authentication：メールリンク（パスワードなし）を有効化
   - Authentication の承認済みドメインに Netlify のドメインを追加（メールリンク用に必須）
   - Firestore：データベース作成（東京 asia-northeast1）し、`firestore.rules` の内容をルールに設定
4. 公開 URL を iPhone で開き、ホーム画面に追加して使う

## 注意
- メールリンクは、リンクを送ったのと同じ端末・ブラウザで開くのが基本
- 無料枠（Firebase Spark／Netlify Free）の範囲で部活規模の利用を想定
