# クラス図（UML）

団体メーラー (Gmailer) の構成を UML クラス図で示します。
Google Apps Script のモジュール（IIFE パターン）を「クラス」、利用する GAS サービス・
受け渡しデータ（DTO）・フロントエンドを併記しています。

- `<<entrypoint>>` … Web アプリのエントリ／API（`Code.gs`）
- `<<module>>` … サーバーロジック（`*.gs` の IIFE）
- `<<frontend>>` … ブラウザ側 JS（`Client.html`）
- `<<dto>>` … API でやり取りするプレーンオブジェクト
- `<<GAS>>` / `<<external>>` … プラットフォーム提供サービス／外部

```mermaid
classDiagram
    direction LR

    class WebApp {
        <<entrypoint Code.gs>>
        +doGet(e) HtmlOutput
        +include(name) string
        +api_listInbox(sid, pageToken) ThreadList
        +api_listSent(sid, pageToken) ThreadList
        +api_getThread(sid, threadId, limit) ThreadDetail
        +api_sendReply(sid, threadId, payload) Result
        +api_sendNew(sid, payload) Result
        +api_logout(sid) Result
    }

    class Pages {
        <<module Code.gs>>
        +login(message) HtmlOutput
        +denied(email) HtmlOutput
        +app(sid, email) HtmlOutput
        -_base(template, bindings, title) HtmlOutput
    }

    class Config {
        <<module Config.gs>>
        +groupEmail() string
        +allowedUsers() List~string~
        +oauthClientId() string
        +oauthClientSecret() string
        +redirectUri() string
        +appTitle() string
        +pageSize() int
        -get(key, def) string
    }

    class Auth {
        <<module Auth.gs>>
        +buildAuthUrl() string
        +consumeState(state) bool
        +exchangeCode(code) string
        +isWhitelisted(email) bool
        +createSession(email) string
        +getSessionEmail(sid) string
        +destroySession(sid) void
        +requireSession(sid) string
        -decodeJwtPayload(jwt) object
        -isGroupMember(group, user) bool
        -SESSION_TTL int
    }

    class Mail {
        <<module Mail.gs>>
        +listThreads(q, pageToken) ThreadList
        +getThread(threadId, limit) ThreadDetail
        +sendNew(payload, actor) Result
        +sendReply(threadId, payload, actor) Result
        -replyAddressesFromGmail(m) ReplyDefaults
        -bodyToDisplayHtml(m) string
        -buildQuoteFromGmail(m) string
        -buildRaw(o) string
        -parseAddrs(str) List~Addr~
        -dedupeEmails(addrs, exclude) List~Addr~
        -THREAD_PAGE int
    }

    class ClientApp {
        <<frontend Client.html>>
        -sid string
        -state object
        -currentThreadId string
        -currentMessages List~Message~
        -currentReplyDefaults ReplyDefaults
        -threadLimit int
        +loadList(folder, append) void
        +openThread(threadId) void
        +fetchThread() void
        +loadMoreThread() void
        +openReply() void
        +sendReply() void
        +openCompose() void
        +sendNew() void
        +renderMessages(wrap, msgs) void
        -call(fn, args) Promise
    }

    %% ---- DTO ----
    class ThreadSummary {
        <<dto>>
        +threadId string
        +subject string
        +who string
        +snippet string
        +date string
        +unread bool
        +count int
        +ts long
    }
    class ThreadList {
        <<dto>>
        +items List~ThreadSummary~
        +nextPageToken string
    }
    class Message {
        <<dto>>
        +id string
        +from string
        +to string
        +cc string
        +date string
        +subject string
        +html string
        +text string
    }
    class ReplyDefaults {
        <<dto>>
        +to string
        +cc string
        +bcc string
    }
    class ThreadDetail {
        <<dto>>
        +threadId string
        +subject string
        +messages List~Message~
        +total int
        +shown int
        +hasMore bool
        +replyDefaults ReplyDefaults
    }
    class ComposePayload {
        <<dto>>
        +to string
        +cc string
        +bcc string
        +subject string
        +body string
    }
    class ReplyPayload {
        <<dto>>
        +to string
        +cc string
        +bcc string
        +body string
    }

    %% ---- GAS / 外部サービス ----
    class GmailApp { <<GAS>> }
    class Gmail { <<GAS Advanced Service>> }
    class CacheService { <<GAS>> }
    class PropertiesService { <<GAS>> }
    class UrlFetchApp { <<GAS>> }
    class GroupsApp { <<GAS>> }
    class ScriptApp { <<GAS>> }
    class HtmlService { <<GAS>> }
    class Utilities { <<GAS>> }
    class GoogleOAuth { <<external>> }

    %% ---- 依存関係 ----
    WebApp ..> Auth
    WebApp ..> Pages
    WebApp ..> Mail
    WebApp ..> CacheService : code 再利用キャッシュ

    Pages ..> Auth
    Pages ..> Config
    Pages ..> HtmlService
    Pages ..> ScriptApp : getUrl()

    Auth ..> Config
    Auth ..> CacheService : セッション/state
    Auth ..> UrlFetchApp : token 交換
    Auth ..> GroupsApp : グループ判定
    Auth ..> Utilities
    Auth ..> GoogleOAuth : 認可/トークン

    Mail ..> Config
    Mail ..> GmailApp : 本文/返信
    Mail ..> Gmail : 一覧/送信(raw)
    Mail ..> Utilities

    Config ..> PropertiesService
    Config ..> ScriptApp

    ClientApp ..> WebApp : google.script.run

    %% ---- DTO の生成/合成 ----
    Mail ..> ThreadList : returns
    Mail ..> ThreadDetail : returns
    ThreadList o-- ThreadSummary
    ThreadDetail o-- Message
    ThreadDetail o-- ReplyDefaults
    ClientApp ..> ComposePayload : creates
    ClientApp ..> ReplyPayload : creates
```

## 補足

- **実行権限の分離**: `Mail` / `Pages`（`ScriptApp.getUrl`）はオーナー（団体アカウント）権限で動作。
  `Auth` はアクセス者の本人確認（OAuth）にのみ関与し、`GoogleOAuth`（`accounts.google.com`）と通信する。
- **セッション**: `Auth` がセッションIDを `CacheService` に保持。`WebApp.api_*` は各呼び出しで
  `Auth.requireSession(sid)` を通す。
- **読み取り/送信の使い分け**: 一覧は `Gmail`（高度なサービス・メタデータ）で軽量取得、本文は
  `GmailApp`（`getBody`/`getPlainBody`）で確実に復号、送信・返信は `Gmail.Users.Messages.send`
  （`raw` + `threadId`）で団体アカウントとして送信。
- **HTML（ビュー）**: `Index.html` / `Login.html` / `Styles.html` / `Client.html` は
  `HtmlService` テンプレートとして `Pages` から評価される（クラス図では `ClientApp` に集約）。
