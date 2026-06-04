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
    var full = Gmail.Users.Threads.get(ME, threadId, { format: 'full' });
    var messages = (full.messages || []).map(function (m) {
      var h = headerMap(m);
      var bodies = extractBodies(m.payload);
      return {
        id: m.id,
        from: h['from'] || '',
        to: h['to'] || '',
        cc: h['cc'] || '',
        date: formatDate(h['date']),
        subject: h['subject'] || '',
        html: bodies.html,
        text: bodies.text
      };
    });
    // 開いたら既読にする（共有運用で「対応済み」が分かるように）
    try {
      Gmail.Users.Threads.modify({ removeLabelIds: ['UNREAD'] }, ME, threadId);
    } catch (e) { /* 既読化失敗は無視 */ }

    var rawMsgs = full.messages || [];
    var last = rawMsgs[rawMsgs.length - 1];
    var subject = messages.length ? messages[messages.length - 1].subject : '';
    var meta = last ? computeReplyMeta(last, headerMap(last)) : { to: '', cc: '' };
    return {
      threadId: threadId,
      subject: subject,
      messages: messages,
      // 「全員に返信」の既定アドレス（クライアントで初期値として表示。編集可）
      replyDefaults: { to: meta.to, cc: meta.cc, bcc: '' }
    };
  }

  /** 「全員に返信」の宛先・件名・スレッド連結用ヘッダーを算出。 */
  function computeReplyMeta(last, h) {
    var group = Config.groupEmail();
    var replyTarget = h['reply-to'] || h['from'] || '';
    var toList = dedupeEmails(
      parseAddrs(replyTarget).concat(parseAddrs(h['to'] || '')),
      [group]
    );
    var ccList = dedupeEmails(
      parseAddrs(h['cc'] || ''),
      [group].concat(toList.map(function (a) { return a.email; }))
    );
    var msgId = h['message-id'] || '';
    return {
      to: toList.map(function (a) { return a.full; }).join(', '),
      cc: ccList.map(function (a) { return a.full; }).join(', '),
      subject: ensureRe(h['subject'] || ''),
      msgId: msgId,
      references: (h['references'] ? h['references'] + ' ' : '') + msgId
    };
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
    var full = Gmail.Users.Threads.get(ME, threadId, { format: 'full' });
    var msgs = full.messages || [];
    if (!msgs.length) throw new Error('対象のスレッドが見つかりません。');
    var last = msgs[msgs.length - 1];
    var h = headerMap(last);
    var meta = computeReplyMeta(last, h);

    var to = (payload.to || '').trim();
    if (!to) throw new Error('宛先（To）を入力してください。');

    var body = (payload.body || '') + '\n\n' + buildQuote(last, h);

    var raw = buildRaw({
      from: Config.groupEmail(),
      to: to,
      cc: (payload.cc || '').trim(),
      bcc: (payload.bcc || '').trim(),
      subject: meta.subject,
      body: body,
      inReplyTo: meta.msgId,
      references: meta.references
    });
    var sent = Gmail.Users.Messages.send({ raw: raw, threadId: threadId }, ME);
    return { ok: true, id: sent.id, threadId: sent.threadId };
  }

  // ---- ヘルパー ---------------------------------------------------------

  function headerMap(message) {
    var map = {};
    var hs = (message && message.payload && message.payload.headers) || [];
    hs.forEach(function (h) { map[h.name.toLowerCase()] = h.value; });
    return map;
  }

  function extractBodies(payload) {
    var html = '', text = '';
    (function walk(part) {
      if (!part) return;
      if (part.parts && part.parts.length) part.parts.forEach(walk);
      var mime = part.mimeType || '';
      if (part.body && part.body.data) {
        var decoded = decodeB64(part.body.data);
        if (mime === 'text/html' && !html) html = decoded;
        else if (mime === 'text/plain' && !text) text = decoded;
      }
    })(payload);
    if (!html && text) {
      html = '<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0;">'
        + escapeHtml(text) + '</pre>';
    }
    return { html: html, text: text };
  }

  function buildQuote(message, h) {
    var bodies = extractBodies(message.payload);
    var text = bodies.text || (bodies.html ? htmlToText(bodies.html) : '');
    var quoted = (text || '').split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n');
    var dateStr = h['date'] ? formatDate(h['date']) : '';
    var from = h['from'] || '';
    return dateStr + ' ' + from + ' のメッセージ:\n' + quoted;
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

  function decodeB64(data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
  }

  function formatDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
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
