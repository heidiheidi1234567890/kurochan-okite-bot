// LINE Wakeup Bot (Node.js) - 毎朝8時に起動、5分おきにメッセージ、1時間で終了 + 除外日・早朝日対応

const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(line.middleware(config)); // こちらを先に
app.use(bodyParser.json());

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

const targetUserId = process.env.TARGET_USER_ID;
const notifyUserIds = process.env.NOTIFY_USER_IDS?.split(',') || [];

let intervalId = null;
let hasResponded = false;

let excludedDates = [];
let earlyWakeupDates = [];

function loadSchedule() {
  try {
    const data = fs.readFileSync('schedule.json', 'utf8');
    const parsed = JSON.parse(data);
    excludedDates = parsed.excludedDates || [];
    earlyWakeupDates = parsed.earlyWakeupDates || [];
    console.log('📂 スケジュール読み込み完了');
  } catch (err) {
    console.log('⚠️ スケジュールファイルが見つかりませんでした、新規作成されます');
    excludedDates = [];
    earlyWakeupDates = [];
  }
}

function saveSchedule() {
  fs.writeFileSync('schedule.json', JSON.stringify({ excludedDates, earlyWakeupDates }, null, 2));
  console.log('💾 スケジュール保存完了');
}

function startWakeupMessages(hour = 8) {
  hasResponded = false;
  sendWakeupMessage();
  intervalId = setInterval(() => {
    if (!hasResponded) {
      sendWakeupMessage();
    }
  },  5 * 60 * 1000);

  setTimeout(() => {
    clearInterval(intervalId);
    if (!hasResponded) {
      notifyUserIds.forEach(uid => {
        client.pushMessage(uid, {
          type: 'text',
          text: `⚠️ ${targetUserId} は心地好い眠りについております`
        });
      });
    }
  }, 60 * 60 * 1000);
}

function sendWakeupMessage() {
  client.pushMessage(targetUserId, {
    type: 'text',
    text: 'おはよう〜！！'
  });
}

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end());
});

function handleEvent(event) {
  console.log('イベント受信:', event); // 受信したイベント全体をログ出力

  if (event.type !== 'message' || event.message.type !== 'text') {
    console.log('テキストメッセージ以外のためスキップ');
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  console.log('受信テキスト:', text);

  if (event.source.userId === targetUserId) {
    console.log('ターゲットユーザーからのメッセージ');
    hasResponded = true;
    clearInterval(intervalId);
    return Promise.all(notifyUserIds.map(uid => {
      console.log('通知送信:', uid);
      return client.pushMessage(uid, {
        type: 'text',
        text: `🟢 ${targetUserId} が目覚めました！`
      });
    })).then(() => console.log('ターゲットユーザー起床通知完了'));
  }

  if (text.startsWith('除外:')) {
    // ... (除外処理)
  }

  if (text.startsWith('変更:')) {
    // ... (変更処理)
  }

  if (text.startsWith('除外削除:')) {
    // ... (除外削除処理)
  }

  if (text.startsWith('変更削除:')) {
    // ... (変更削除処理)
  }

  if (text === '一覧') {
    // ... (一覧表示処理)
  }

  console.log('イベント処理完了');
  return Promise.resolve(null);
}
app.get('/', (req, res) => res.send('LINE Wakeup Bot Running'));

loadSchedule();
schedule.scheduleJob('0 23 * * *', () => {
  const today = new Date();
  const yyyyMMdd = today.toISOString().split('T')[0];

  if (excludedDates.includes(yyyyMMdd)) {
    console.log(`⛔ ${yyyyMMdd} は除外日のためスキップされました`);
    return;
  }

  const hour = earlyWakeupDates.includes(yyyyMMdd) ? 7 : 8;
  console.log(`⏰ ${hour}:00 (JST) - Wakeup Botスタート`);
  startWakeupMessages(hour);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
