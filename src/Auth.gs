/**
 * Auth.gs
 * サーバーサイド OAuth 2.0 認可コードフロー（OpenID Connect）による本人確認と、
 * ホワイトリスト判定、簡易セッション管理。
 *
 * 流れ:
 *   1) buildAuthUrl() で Google 同意画面への URL を生成（ログイン画面のリンクに使用）
 *   2) Google が redirect_uri（=このWebアプリの /exec URL）へ ?code= 付きでリダイレクト
 *   3) exchangeCode() で code を id_token に交換し、email を取得・検証
 *   4) isWhitelisted() で許可ユーザーか判定
 *   5) createSession() でセッションID（sid）を発行し、以降の API 呼び出しで本人確認
 */
var Auth = (function () {
  var AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  var SESSION_TTL = 21600; // 6時間（CacheService の上限）

  function cache() { return CacheService.getScriptCache(); }

  /** 同意画面 URL を生成し、CSRF 対策の state をキャッシュに保存。 */
  function buildAuthUrl() {
    var state = Utilities.getUuid();
    cache().put('state_' + state, '1', 600);
    var params = {
      client_id: Config.oauthClientId(),
      redirect_uri: Config.redirectUri(),
      response_type: 'code',
      scope: 'openid email',
      state: state,
      prompt: 'select_account',
      access_type: 'online'
    };
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return AUTH_ENDPOINT + '?' + qs;
  }

  /** state の検証（ワンタイム）。 */
  function consumeState(state) {
    if (!state) return false;
    var ok = cache().get('state_' + state);
    if (ok) cache().remove('state_' + state);
    return !!ok;
  }

  /** 認可コードを id_token に交換し、検証済みの email（小文字）を返す。 */
  function exchangeCode(code) {
    if (!Config.oauthClientId() || !Config.oauthClientSecret()) {
      throw new Error('OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET が未設定です。');
    }
    var res = UrlFetchApp.fetch(TOKEN_ENDPOINT, {
      method: 'post',
      muteHttpExceptions: true,
      payload: {
        code: code,
        client_id: Config.oauthClientId(),
        client_secret: Config.oauthClientSecret(),
        redirect_uri: Config.redirectUri(),
        grant_type: 'authorization_code'
      }
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('トークン交換に失敗しました: ' + res.getContentText());
    }
    var data = JSON.parse(res.getContentText());
    if (!data.id_token) throw new Error('id_token を取得できませんでした。');

    // id_token は Google の token エンドポイントから TLS 経由で直接受領しているため、
    // 署名は信頼できる。aud / iss / email を念のため検証する。
    var claims = decodeJwtPayload(data.id_token);
    if (claims.aud !== Config.oauthClientId()) {
      throw new Error('id_token の aud が一致しません。');
    }
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
      throw new Error('id_token の iss が不正です。');
    }
    if (!claims.email) throw new Error('メールアドレスを取得できませんでした。');
    if (claims.email_verified === false) throw new Error('メールアドレスが未確認です。');
    return String(claims.email).toLowerCase();
  }

  function decodeJwtPayload(jwt) {
    var parts = jwt.split('.');
    if (parts.length < 2) throw new Error('id_token の形式が不正です。');
    var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString('UTF-8');
    return JSON.parse(json);
  }

  /** ホワイトリスト判定。完全一致の email、または @googlegroups.com のメンバーシップ。 */
  function isWhitelisted(email) {
    email = (email || '').toLowerCase();
    if (!email) return false;
    var allowed = Config.allowedUsers();
    for (var i = 0; i < allowed.length; i++) {
      var entry = allowed[i];
      if (!entry) continue;
      if (entry === email) return true;
      if (entry.indexOf('@googlegroups.com') !== -1 && isGroupMember(entry, email)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Google グループのメンバーか判定。
   * 注意: GroupsApp はオーナー（実行アカウント）が参照可能なグループに限る。
   * 一般消費者向け（@gmail.com 同士）の @googlegroups.com では参照できず false を返す場合がある。
   */
  function isGroupMember(groupEmail, userEmail) {
    try {
      return GroupsApp.getGroupByEmail(groupEmail).hasUser(userEmail);
    } catch (e) {
      return false;
    }
  }

  function createSession(email) {
    var sid = Utilities.getUuid();
    cache().put('sess_' + sid, email, SESSION_TTL);
    return sid;
  }

  /** セッションを検証し email を返す。有効ならスライディングで TTL を延長。 */
  function getSessionEmail(sid) {
    if (!sid) return null;
    var email = cache().get('sess_' + sid);
    if (email) cache().put('sess_' + sid, email, SESSION_TTL);
    return email;
  }

  function destroySession(sid) {
    if (sid) cache().remove('sess_' + sid);
  }

  /** API から呼ぶ。無効なら例外。 */
  function requireSession(sid) {
    var email = getSessionEmail(sid);
    if (!email) throw new Error('セッションが無効です。再度ログインしてください。');
    return email;
  }

  return {
    buildAuthUrl: buildAuthUrl,
    consumeState: consumeState,
    exchangeCode: exchangeCode,
    isWhitelisted: isWhitelisted,
    createSession: createSession,
    getSessionEmail: getSessionEmail,
    destroySession: destroySession,
    requireSession: requireSession
  };
})();
