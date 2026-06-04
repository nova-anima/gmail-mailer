/**
 * Code.gs
 * Web アプリのエントリポイント（doGet）と、クライアントから呼ばれる API 関数群。
 */

/** Web アプリのエントリポイント。 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // ログインがキャンセル/失敗
    if (p.error) {
      return Pages.login('ログインがキャンセルされました（' + p.error + '）。');
    }

    // OAuth コールバック（?code=...）
    if (p.code) {
      var cache = CacheService.getScriptCache();
      var sid = cache.get('code_' + p.code); // 再読み込み時の二重交換を防ぐ
      if (!sid) {
        if (!Auth.consumeState(p.state)) {
          return Pages.login('不正なログイン要求です（state 不一致）。もう一度お試しください。');
        }
        var email = Auth.exchangeCode(p.code);
        if (!Auth.isWhitelisted(email)) {
          return Pages.denied(email);
        }
        sid = Auth.createSession(email);
        cache.put('code_' + p.code, sid, 300);
      }
      var sessEmail = Auth.getSessionEmail(sid);
      if (!sessEmail) return Pages.login('セッションの作成に失敗しました。もう一度お試しください。');
      return Pages.app(sid, sessEmail);
    }

    // 既存セッション（?sid=...）
    if (p.sid) {
      var em = Auth.getSessionEmail(p.sid);
      if (em) return Pages.app(p.sid, em);
    }

    // 未ログイン
    return Pages.login('');
  } catch (err) {
    return Pages.login('エラー: ' + (err && err.message ? err.message : String(err)));
  }
}

/** HTML テンプレートから他ファイルをインライン展開するためのヘルパー。 */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ============================ ページ生成 ============================ */

var Pages = {
  _base: function (templateName, bindings, title) {
    var t = HtmlService.createTemplateFromFile(templateName);
    Object.keys(bindings || {}).forEach(function (k) { t[k] = bindings[k]; });
    return t.evaluate()
      .setTitle(title || Config.appTitle())
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  },
  login: function (message) {
    return Pages._base('Login', {
      authUrl: Auth.buildAuthUrl(),
      message: message || '',
      appTitle: Config.appTitle()
    });
  },
  denied: function (email) {
    return Pages._base('Login', {
      authUrl: Auth.buildAuthUrl(),
      message: (email || '') + ' はこのアプリの利用を許可されていません。管理者にお問い合わせください。',
      appTitle: Config.appTitle()
    });
  },
  app: function (sid, email) {
    return Pages._base('Index', {
      sid: sid,
      userEmail: email,
      groupEmail: Config.groupEmail(),
      appTitle: Config.appTitle(),
      appUrl: ScriptApp.getService().getUrl()
    });
  }
};

/* ============================ API 関数 ============================ */
/* いずれも第1引数に sid を受け取り、セッション検証を行う。 */

function api_listInbox(sid, pageToken) {
  Auth.requireSession(sid);
  return Mail.listThreads('in:inbox', pageToken);
}

function api_listSent(sid, pageToken) {
  Auth.requireSession(sid);
  return Mail.listThreads('in:sent', pageToken);
}

function api_getThread(sid, threadId) {
  Auth.requireSession(sid);
  return Mail.getThread(threadId);
}

function api_sendReply(sid, threadId, payload) {
  var email = Auth.requireSession(sid);
  return Mail.sendReply(threadId, payload, email);
}

function api_sendNew(sid, payload) {
  var email = Auth.requireSession(sid);
  return Mail.sendNew(payload, email);
}

function api_logout(sid) {
  Auth.destroySession(sid);
  return { ok: true };
}
