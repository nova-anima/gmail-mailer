/**
 * Mail.gs
 * Gmail 高度なサービス（Advanced Service: Gmail v1）を用いた
 * スレッド一覧取得 / スレッド本文取得 / 返信 / 新規送信。
 *
 * すべてオーナー（=団体アカウント。executeAs: USER_DEPLOYING）の権限で動作するため、
 * 共有メールボックスの閲覧、団体アカウントとしての送信、送信済みへの反映が行える。
 */
var Mail = (function () {
  var ME = 'me';

  // ---- 一覧 -------------------------------------------------------------

  function listThreads(q, pageToken) {
    var res = Gmail.Users.Threads.list(ME, {
      q: q,
      maxResults: Config.pageSize(),
      pageToken: pageToken || undefined
    });
    var isSent = q.indexOf('in:sent') !== -1;
    var items = (res.threads || []).map(function (t) {
      var full = Gmail.Users.Threads.get(ME, t.id, {
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date']
      });
      var msgs = full.messages || [];
      var last = msgs[msgs.length - 1] || {};
      var h = headerMap(last);
      var unread = msgs.some(function (m) {
        return (m.labelIds || []).indexOf('UNREAD') !== -1;
      });
      return {
        threadId: t.id,
        subject: h['subject'] || '(件名なし)',
        who: isSent ? (h['to'] || '') : (h['from'] || ''),
        whoLabel: isSent ? '宛先' : '差出人',
        snippet: t.snippet || last.snippet || '',
        date: formatDate(h['date']),
        unread: unread,
        count: msgs.length
      };
    });
    return { items: items, nextPageToken: res.nextPageToken || '' };
  }

  // ---- スレッド本文 -----------------------------------------------------

  function getThread(threadId) {
    // 本文は GmailApp で取得する（base64/文字コードを GAS が正しく処理するため確実）。
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) throw new Error('スレッドが見つかりません。');
    var gmsgs = thread.getMessages();
    var messages = gmsgs.map(function (m) {
      return {
        id: m.getId(),
        from: m.getFrom() || '',
        to: m.getTo() || '',
        cc: m.getCc() || '',
        date: formatDateObj(m.getDate()),
        subject: m.getSubject() || '',
        html: bodyToDisplayHtml(m),        // 表示用HTML（素テキストは改行を保持）
        text: m.getPlainBody() || ''
      };
    });
    // 開いたら既読にする（共有運用で「対応済み」が分かるように）
    try { thread.markRead(); } catch (e) { /* 既読化失敗は無視 */ }

    var last = gmsgs[gmsgs.length - 1];
    var defaults = last ? replyAddressesFromGmail(last) : { to: '', cc: '' };
    return {
      threadId: threadId,
      subject: messages.length ? messages[messages.length - 1].subject : '',
      messages: messages,
      // 「全員に返信」の既定アドレス（クライアントで初期値として表示。編集可）
      replyDefaults: { to: defaults.to, cc: defaults.cc, bcc: '' }
    };
  }

  /** GmailMessage から「全員に返信」の宛先(To/Cc)を算出（団体アドレスは除外）。 */
  function replyAddressesFromGmail(m) {
    var group = Config.groupEmail();
    var replyTarget = m.getReplyTo() || m.getFrom() || '';
    var toList = dedupeEmails(
      parseAddrs(replyTarget).concat(parseAddrs(m.getTo() || '')),
      [group]
    );
    var ccList = dedupeEmails(
      parseAddrs(m.getCc() || ''),
      [group].concat(toList.map(function (a) { return a.email; }))
    );
    return {
      to: toList.map(function (a) { return a.full; }).join(', '),
      cc: ccList.map(function (a) { return a.full; }).join(', ')
    };
  }

  /**
   * 表示用 HTML を返す。HTML メールはそのまま、プレーンテキストのメールは
   * 改行・空白を保持するため <pre> で包んでエスケープする
   * （GmailApp.getBody() は素テキストの改行を <br> 化しないため、そのままだと1行になる）。
   */
  function bodyToDisplayHtml(m) {
    var html = m.getBody() || '';
    if (looksLikeHtml(html)) return html;
    var text = m.getPlainBody() || html;
    return '<pre style="white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;'
      + 'font-family:inherit;margin:0;">' + escapeHtml(text) + '</pre>';
  }

  function looksLikeHtml(s) {
    return /<(br|p|div|table|tbody|tr|td|span|a|ul|ol|li|h[1-6]|blockquote|img|pre|html|body|font|b|i|strong|em)\b|<\/(p|div|table|body|html|span|a)>/i.test(String(s));
  }

  // ---- 送信 -------------------------------------------------------------

  function sendNew(payload, actorEmail) {
    var to = (payload.to || '').trim();
    if (!to) throw new Error('宛先（To）を入力してください。');
    var raw = buildRaw({
      from: Config.groupEmail(),
      to: to,
      cc: (payload.cc || '').trim(),
      bcc: (payload.bcc || '').trim(),
      subject: payload.subject || '',
      body: payload.body || ''
    });
    var sent = Gmail.Users.Messages.send({ raw: raw }, ME);
    return { ok: true, id: sent.id, threadId: sent.threadId };
  }

  /**
   * 返信を送信。宛先（To/Cc/Bcc）はクライアントから受け取った値を使用する
   * （既定値は getThread の replyDefaults =「全員に返信」のアドレス。ユーザーが編集可能）。
   * 引用を本文末尾に付与し、同一スレッドに送信する。
   */
  function sendReply(threadId, payload, actorEmail) {
    payload = payload || {};
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) throw new Error('対象のスレッドが見つかりません。');
    var gmsgs = thread.getMessages();
    if (!gmsgs.length) throw new Error('対象のスレッドが見つかりません。');
    var last = gmsgs[gmsgs.length - 1];

    var to = (payload.to || '').trim();
    if (!to) throw new Error('宛先（To）を入力してください。');

    var subject = ensureRe(last.getSubject() || '');

    // スレッド連結（In-Reply-To / References）用の Message-ID を取得
    var msgId = '', references = '';
    try {
      var meta = Gmail.Users.Messages.get(ME, last.getId(), {
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References']
      });
      var mh = headerMap(meta);
      msgId = mh['message-id'] || '';
      references = (mh['references'] ? mh['references'] + ' ' : '') + msgId;
    } catch (e) { /* 取得できなくても threadId でスレッドは維持される */ }

    var body = (payload.body || '') + '\n\n' + buildQuoteFromGmail(last);

    var raw = buildRaw({
      from: Config.groupEmail(),
      to: to,
      cc: (payload.cc || '').trim(),
      bcc: (payload.bcc || '').trim(),
      subject: subject,
      body: body,
      inReplyTo: msgId,
      references: references
    });
    var sent = Gmail.Users.Messages.send({ raw: raw, threadId: threadId }, ME);
    return { ok: true, id: sent.id, threadId: sent.threadId };
  }

  /** GmailMessage から Gmail 風の引用ブロックを作成。 */
  function buildQuoteFromGmail(m) {
    var text = m.getPlainBody() || htmlToText(m.getBody() || '');
    var quoted = (text || '').split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n');
    return formatDateObj(m.getDate()) + ' ' + (m.getFrom() || '') + ' のメッセージ:\n' + quoted;
  }

  // ---- ヘルパー ---------------------------------------------------------

  function headerMap(message) {
    var map = {};
    var hs = (message && message.payload && message.payload.headers) || [];
    hs.forEach(function (h) { map[h.name.toLowerCase()] = h.value; });
    return map;
  }

  function htmlToText(html) {
    return String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>(?:\s*)/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** RFC 822 メッセージを組み立て、Gmail API 用に base64url 化して返す。 */
  function buildRaw(o) {
    var nl = '\r\n';
    var headers = [];
    headers.push('From: ' + o.from);
    headers.push('To: ' + (o.to || ''));
    if (o.cc) headers.push('Cc: ' + o.cc);
    if (o.bcc) headers.push('Bcc: ' + o.bcc);
    headers.push('Subject: ' + encodeSubject(o.subject || ''));
    if (o.inReplyTo) headers.push('In-Reply-To: ' + o.inReplyTo);
    if (o.references) headers.push('References: ' + o.references);
    headers.push('MIME-Version: 1.0');
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');

    var bodyB64 = Utilities.base64Encode(o.body || '', Utilities.Charset.UTF_8)
      .replace(/(.{76})/g, '$1' + nl);
    var mime = headers.join(nl) + nl + nl + bodyB64;
    return Utilities.base64EncodeWebSafe(mime);
  }

  function encodeSubject(s) {
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    return '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
  }

  function parseAddrs(str) {
    if (!str) return [];
    var parts = str.match(/(?:"[^"]*"|[^,])+/g) || [];
    return parts.map(function (p) { return p.trim(); })
      .filter(Boolean)
      .map(function (p) {
        var m = p.match(/<([^>]+)>/);
        var email = (m ? m[1] : p).trim().toLowerCase();
        return { full: p, email: email };
      })
      .filter(function (a) { return a.email.indexOf('@') !== -1; });
  }

  function dedupeEmails(addrs, excludeEmails) {
    var ex = (excludeEmails || []).map(function (e) { return (e || '').toLowerCase(); });
    var seen = {}, out = [];
    addrs.forEach(function (a) {
      if (!a.email || seen[a.email] || ex.indexOf(a.email) !== -1) return;
      seen[a.email] = true;
      out.push(a);
    });
    return out;
  }

  function ensureRe(s) {
    return /^re:/i.test(String(s).trim()) ? s : 'Re: ' + s;
  }

  function formatDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return formatDateObj(d);
  }

  function formatDateObj(d) {
    if (!d || isNaN(d.getTime && d.getTime())) return '';
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    listThreads: listThreads,
    getThread: getThread,
    sendNew: sendNew,
    sendReply: sendReply
  };
})();
