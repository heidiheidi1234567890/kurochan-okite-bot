// LINE Wakeup Bot (Node.js) - 毎朝8時に起動、5分おきにメッセージ、1時間で終了

const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const getRawBody = require('raw-body'); // 追加

dotenv.config();

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// middleware 修正（raw bodyを通す）
app.post('/webhook', (req, res, next) => {
  getRawBody(req, {
    length: req.headers['content-length'],
    limit: '1mb',
    encoding: req.charset || 'utf-8'
  }, (err, string) => {
    if (err) return next(err);
    req.rawBody = string;
    next();
  });
}, line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error('イベント処理エラー:', err);
      res.status(500).end();
    });
});
const client = new line.Client(config);

const targetUserId = process.env.TARGET_USER_ID;
const notifyUserIds = process.env.NOTIFY_USER_IDS?.split(',') || [];

let intervalId = null;
let hasResponded = false;

// 除外・変更スケジュールの保存先
const schedulePath = path.join(__dirname, 'schedule.json');
function loadSchedule() {
  try {
    return JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
  } catch (e) {
    return { exclude: [], override: {} };
  }
}
function saveSchedule(schedule) {
  fs.writeFileSync(schedulePath, JSON.stringify(schedule, null, 2));
}

function startWakeupMessages(startHour = 8) {
  hasResponded = false;
  sendWakeupMessage();
  intervalId = setInterval(() => {
    if (!hasResponded) {
      sendWakeupMessage();
    }
  }, 5 * 60 * 1000); // 5分おき

  // 開始時刻から1時間後に自動停止
  setTimeout(() => {
    clearInterval(intervalId);
    if (!hasResponded) {
      notifyUserIds.forEach(uid => {
        client.pushMessage(uid, {
          type: 'text',
          text: `⚠️ ${targetUserId} は1時間返事がありませんでした…`
        });
      });
    }
  }, 60 * 60 * 1000);
}

function sendWakeupMessage() {
  client.pushMessage(targetUserId, {
    type: 'text',
    text: 'おはよう〜！起きてる？？👀'
  });
}

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error('Webhook error:', err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const schedule = loadSchedule();
  const isAdmin = notifyUserIds.includes(userId);

  // ① コマンド処理
  if (isAdmin) {
    if (text.startsWith('除外')) {
      const dateStr = text.replace('除外', '').trim();
      if (!schedule.exclude.includes(dateStr)) {
        schedule.exclude.push(dateStr);
        saveSchedule(schedule);
      }
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📅 ${dateStr} を除外日に追加しました！`
      });
    }

    if (text.startsWith('変更')) {
      const parts = text.replace('変更', '').trim().split(' ');
      const dateStr = parts[0];
      const hour = parseInt(parts[1]);
      if (dateStr && hour >= 0 && hour <= 23) {
        schedule.override[dateStr] = hour;
        saveSchedule(schedule);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `⏰ ${dateStr} を ${hour} 時開始に変更しました！`
        });
      }
    }

    if (text === '一覧') {
      const list = [
        '📋 除外日一覧:',
        ...schedule.exclude.map(d => `・${d}`),
        '',
        '📋 変更日一覧:',
        ...Object.entries(schedule.override).map(([d, h]) => `・${d}: ${h}時 開始`)
      ];
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: list.join('\n') || '登録はありません。'
      });
    }
  }

  // ② 通常の応答処理
  if (userId === targetUserId) {
    hasResponded = true;
    clearInterval(intervalId);
    return Promise.all(notifyUserIds.map(uid =>
      client.pushMessage(uid, {
        type: 'text',
        text: `🟢 ${targetUserId} が返信しました！`
      })
    ));
  }

  return Promise.resolve(null);
}

app.get('/', (req, res) => res.send('LINE Wakeup Bot Running'));

// 毎日スケジュール：日本時間8時 or 特別指定時間、除外日はスキップ
schedule.scheduleJob('0 23 * * *', () => {
  const today = new Date();
  today.setHours(today.getHours() + 9); // JSTに変換
  const ymd = today.toISOString().slice(0, 10);
  const schedule = loadSchedule();

  if (schedule.exclude.includes(ymd)) {
    console.log(`🚫 ${ymd} は除外日です`);
    return;
  }

  const hour = schedule.override[ymd] ?? 8;
  const nowUTC = new Date();
  const delayMs = ((hour - 9 + 24) % 24) * 60 * 60 * 1000; // JST→UTC
  const runAt = new Date(nowUTC.getTime() + delayMs);

  console.log(`✅ ${ymd} に ${hour}時開始予定（JST）`);
  schedule.scheduleJob(runAt, () => {
    console.log(`⏰ ${ymd} - ${hour}時（JST）Wakeup Botスタート`);
    startWakeupMessages(hour);
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
