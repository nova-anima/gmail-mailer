/**
 * Config.gs
 * スクリプトプロパティから設定を読み出すための薄いラッパー。
 *
 * 必須プロパティ（プロジェクトの設定 > スクリプトプロパティ で登録）:
 *   GROUP_EMAIL          団体アカウントのメールアドレス（このアプリを実行＝デプロイするアカウント）
 *   ALLOWED_USERS        利用を許可するユーザー。カンマ区切り。
 *                        例: a@gmail.com, b@gmail.com, team@googlegroups.com
 *   OAUTH_CLIENT_ID      ログイン用 OAuth 2.0 クライアントID（種類: ウェブアプリケーション）
 *   OAUTH_CLIENT_SECRET  上記クライアントのシークレット
 * 任意プロパティ:
 *   REDIRECT_URI         未設定なら ScriptApp.getService().getUrl() を使用
 *   APP_TITLE            画面タイトル（既定: 団体メーラー）
 *   PAGE_SIZE            一覧の1ページ件数（既定: 20）
 */
var Config = (function () {
  var props = PropertiesService.getScriptProperties();

  function get(key, def) {
    var v = props.getProperty(key);
    return (v === null || v === undefined || v === '') ? def : v;
  }

  return {
    groupEmail: function () {
      return (get('GROUP_EMAIL', '') || '').trim().toLowerCase();
    },
    allowedUsers: function () {
      return get('ALLOWED_USERS', '')
        .split(',')
        .map(function (s) { return s.trim().toLowerCase(); })
        .filter(function (s) { return !!s; });
    },
    oauthClientId: function () { return (get('OAUTH_CLIENT_ID', '') || '').trim(); },
    oauthClientSecret: function () { return (get('OAUTH_CLIENT_SECRET', '') || '').trim(); },
    redirectUri: function () {
      var v = (get('REDIRECT_URI', '') || '').trim();
      return v || ScriptApp.getService().getUrl();
    },
    appTitle: function () { return get('APP_TITLE', '団体メーラー'); },
    pageSize: function () {
      var n = parseInt(get('PAGE_SIZE', '20'), 10);
      return (n > 0 && n <= 100) ? n : 20;
    }
  };
})();
