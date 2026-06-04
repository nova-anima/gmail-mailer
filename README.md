# 団体メーラー (Gmailer)

団体で共有している Gmail アドレス（`@gmail.com`）のメールを、**複数人で閲覧・返信**するための簡易メーラーです。
Google Apps Script の Web アプリとして動作し、PC／スマホのブラウザから利用できます。

## 主な機能

- ログイン（Google サインイン）後、許可されたユーザー（ホワイトリスト）だけが利用可能
- 受信メール一覧 / 送信済みメール一覧（件名と本文の冒頭を一覧表示）
- 受信メールを開いて本文を表示（HTML メールはサンドボックス iframe で安全に表示）
- **全員に返信**（引用を本文末尾に自動付与し、同一スレッドへ送信）
- 新規作成（To / Cc / Bcc 指定）
- 送信は団体アカウントとして行われ、団体アカウントの「送信済み」に残る
- スマホ対応のレスポンシブレイアウト

## アーキテクチャ（認証方式）

GAS の `HtmlService` は動的サブドメインの `googleusercontent.com` iframe 内で実行されるため、
Google Identity Services（GIS）のボタン/One Tap は「承認済み JavaScript 生成元」を事前登録できず不安定です。
そこで本アプリは **サーバーサイドの OAuth 2.0 認可コードフロー（OpenID Connect）** で本人確認します。

1. ログイン画面の「Google でログイン」（`target="_top"`）→ Google 同意画面
2. 安定した `/exec` URL（= `redirect_uri`）へ `?code=` 付きで戻る
3. サーバーで `code` を `id_token` に交換し、`email` を検証 → ホワイトリスト判定
4. セッション ID を発行（`CacheService`）。以降の API 呼び出しで本人確認

Gmail の読み書きは **オーナー（団体アカウント）権限**（`executeAs: USER_DEPLOYING`）で実行されるため、
共有メールボックスの閲覧・団体アカウントとしての送信・送信済みへの反映が行えます。
ログイン用 OAuth はあくまで「アクセス者の本人確認」にのみ使用し、各ユーザーに Gmail 権限は付与しません。

---

## セットアップ手順

> ⚠️ 以下の操作は、すべて **団体アカウント（`GROUP_EMAIL`）でログインした状態** で行ってください。
> このアカウントが Apps Script プロジェクトのオーナー兼デプロイ実行者になります。

### 0. 前提

- Node.js（clasp 利用のため）
- clasp: `npm install`（このリポジトリの devDependencies）または `npm i -g @google/clasp`
- [Apps Script API を有効化](https://script.google.com/home/usersettings)（「Google Apps Script API」をオン）

### 1. clasp ログイン & プロジェクト作成

団体アカウントでログインします。

```bash
npm install
npx clasp login          # ブラウザで団体アカウントを選択
```

新規スクリプトを作成（または既存をクローン）:

```bash
# 新規作成する場合
npx clasp create --type webapp --title "団体メーラー" --rootDir src
# → 生成された .clasp.json の "rootDir" が "src" になっていることを確認
```

または、すでに `.clasp.json.example` を使う場合は、ブラウザで作成したスクリプトの
スクリプト ID を控え、`.clasp.json.example` を `.clasp.json` にコピーして `scriptId` を記入します。

### 2. コードを push

```bash
npx clasp push
```

`src/` 配下（`appsscript.json`, `*.gs`, `*.html`）がアップロードされます。

### 3. GCP プロジェクトを紐付け（OAuth クライアント作成のため）

1. Apps Script エディタを開く: `npx clasp open`
2. 左メニュー **プロジェクトの設定（⚙）** → **Google Cloud Platform (GCP) プロジェクト** →
   **プロジェクトを変更** で、**標準の GCP プロジェクト**を作成して紐付けます。
   （標準プロジェクトでないと OAuth クライアントを作成できません）

### 4. OAuth 同意画面の設定

[Google Cloud Console](https://console.cloud.google.com/) で、上記 GCP プロジェクトを選択し:

1. **API とサービス → OAuth 同意画面**
2. User Type: **外部**（個人 `@gmail.com` の場合）
3. アプリ名・サポートメール等を入力
4. スコープは追加不要（`openid`, `email` は基本スコープ）
5. **テストユーザー** に、利用する全員の `@gmail.com` を追加
   （「公開」ステータスにしない限り、テストユーザー以外はログインできません）

### 5. OAuth クライアント ID（ウェブアプリケーション）を作成

1. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
2. アプリケーションの種類: **ウェブアプリケーション**
3. **承認済みのリダイレクト URI** は、後述の **デプロイ後に取得する `/exec` URL** を登録します（手順 7）
4. 作成後に表示される **クライアント ID** と **クライアント シークレット** を控える

### 6. Web アプリとしてデプロイ

Apps Script エディタ右上 **デプロイ → 新しいデプロイ**:

- 種類: **ウェブアプリ**
- 次のユーザーとして実行: **自分（団体アカウント）**
- アクセスできるユーザー: **全員**
  （本アプリが独自に OAuth で認証するため匿名アクセスを許可。`appsscript.json` の `ANYONE_ANONYMOUS` と対応）

デプロイ後に表示される **ウェブアプリの URL（`https://script.google.com/macros/s/XXXX/exec`）** を控えます。

```bash
# CLI で行う場合
npx clasp deploy
npx clasp deployments   # /exec URL を確認
```

### 7. リダイレクト URI を登録

手順 5 の OAuth クライアントの **承認済みのリダイレクト URI** に、手順 6 の **`/exec` URL** を追加して保存します。
（テストでエディタの `/dev` URL も使う場合は、その URL も追加してください）

### 8. スクリプトプロパティを設定

Apps Script エディタ **プロジェクトの設定 → スクリプト プロパティ** で以下を登録:

| プロパティ | 値 | 必須 |
|---|---|---|
| `GROUP_EMAIL` | 団体アカウントのアドレス（例 `team@gmail.com`） | ✅ |
| `ALLOWED_USERS` | 許可ユーザーをカンマ区切り（例 `a@gmail.com, b@gmail.com, group@googlegroups.com`） | ✅ |
| `OAUTH_CLIENT_ID` | 手順 5 のクライアント ID | ✅ |
| `OAUTH_CLIENT_SECRET` | 手順 5 のクライアント シークレット | ✅ |
| `REDIRECT_URI` | 通常は不要（未設定なら `/exec` を自動使用）。`/dev` 等を固定したい場合のみ指定 | － |
| `APP_TITLE` | 画面タイトル（既定: `団体メーラー`） | － |
| `PAGE_SIZE` | 一覧の1ページ件数（既定: `20`） | － |

### 9. 初回認可

Apps Script エディタで関数 `doGet` を一度実行（または `/exec` を開く）し、
**Gmail / 外部リクエスト等の権限を団体アカウントで承認**します。

### 10. 動作確認

`/exec` URL を許可済みユーザーのブラウザで開く → 「Google でログイン」→ メーラー画面が表示されれば完了です。

---

## 運用上の注意

- **既読化**: 受信スレッドを開くと UNREAD ラベルを外し既読にします（共有運用で「対応済み」が分かるように）。
- **添付ファイル**: 本バージョンは非対応（本文テキストの閲覧・送信のみ）。HTML メールは表示します。
- **`@googlegroups.com` 判定**: `GroupsApp` がオーナーから参照できるグループに限ります。
  一般消費者向けグループでは判定できない場合があります。その場合は個別アドレスをホワイトリストに記載してください。
- **セッション**: `CacheService` 上で約 6 時間有効（アクセスごとに延長）。失効後は再ログイン。
- **デプロイ更新**: コード変更後は `clasp push` し、同じデプロイを「デプロイを管理 → 編集（鉛筆）→ バージョン: 新バージョン」で更新すると `/exec` URL が変わりません。
  新規デプロイを作り直すと URL が変わり、リダイレクト URI の再登録が必要になります。

## ファイル構成

```
Gmailer/
├── src/
│   ├── appsscript.json   マニフェスト（スコープ / Gmail 高度なサービス / Web アプリ設定）
│   ├── Config.gs         スクリプトプロパティのアクセサ
│   ├── Auth.gs           OAuth コードフロー / ホワイトリスト / セッション
│   ├── Mail.gs           Gmail 一覧・本文・返信・送信
│   ├── Code.gs           doGet とクライアント向け API
│   ├── Index.html        アプリ本体（ビュー構成）
│   ├── Login.html        ログイン画面
│   ├── Styles.html       CSS（レスポンシブ）
│   └── Client.html       フロントエンド JS
├── .clasp.json.example   → .clasp.json にコピーして scriptId を記入
├── .claspignore
├── package.json
└── README.md
```

## トラブルシューティング

- **`redirect_uri_mismatch`**: OAuth クライアントの承認済みリダイレクト URI と、実際の `/exec`（または `/dev`）URL が不一致。手順 7 を確認。
- **ログインしても「利用を許可されていません」**: `ALLOWED_USERS` にそのアドレスが含まれているか確認（前後空白・大文字小文字は無視されます）。
- **`access_denied` / テストユーザー未登録**: OAuth 同意画面のテストユーザーに追加（手順 4）。
- **Gmail のデータが出ない**: 初回認可（手順 9）が未実施、または `GROUP_EMAIL` 以外のアカウントでデプロイしている可能性。
