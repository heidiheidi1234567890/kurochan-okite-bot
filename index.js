// LINE Wakeup Bot (Node.js) - 毎朝8時に起動、5分おきにメッセージ、1時間で終了 + 除外日・早朝日対応

const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const fs = require('fs');

dotenv.config();

const app = express();
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
  },  * 60 * 1000);

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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  if (event.source.userId === targetUserId) {
    hasResponded = true;
    clearInterval(intervalId);
    return Promise.all(notifyUserIds.map(uid =>
      client.pushMessage(uid, {
        type: 'text',
        text: `🟢 ${targetUserId} が目覚めました！`
      })
    ));
  }

  if (text.startsWith('除外:')) {
    const date = text.slice(3).trim();
    if (!excludedDates.includes(date)) {
      excludedDates.push(date);
      saveSchedule();
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📅 ${date} を除外日に登録しました`
      });
    }
  }

  if (text.startsWith('変更:')) {
    const date = text.slice(3).trim();
    if (!earlyWakeupDates.includes(date)) {
      earlyWakeupDates.push(date);
      saveSchedule();
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `⏰ ${date} の変更を登録しました`
      });
    }
  }

  if (text.startsWith('除外削除:')) {
    const date = text.slice(5).trim();
    const index = excludedDates.indexOf(date);
    if (index !== -1) {
      excludedDates.splice(index, 1);
      saveSchedule();
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `🗑 ${date} を除外日から削除しました`
      });
    }
  }

  if (text.startsWith('変更削除:')) {
    const date = text.slice(5).trim();
    const index = earlyWakeupDates.indexOf(date);
    if (index !== -1) {
      earlyWakeupDates.splice(index, 1);
      saveSchedule();
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `🗑 ${date} を変更から削除しました`
      });
    }
  }

  if (text === '一覧') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📋 除外日: ${excludedDates.join(', ') || 'なし'}\n⏰ 変更日: ${earlyWakeupDates.join(', ') || 'なし'}`
    });
  }

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
