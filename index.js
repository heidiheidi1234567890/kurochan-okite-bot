// LINE Wakeup Bot (Node.js) - 毎朝8時に起動、5分おきにメッセージ、1時間で終了

const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const schedule = require('node-schedule'); // スケジュール機能追加

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

function startWakeupMessages() {
  hasResponded = false;
  sendWakeupMessage();
  intervalId = setInterval(() => {
    if (!hasResponded) {
      sendWakeupMessage();
    }
  }, 5 * 60 * 1000); // 5分おき

  // 1時間後に自動停止
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
  }, 60 * 60 * 1000); // 1時間後
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
    .then(() => res.status(200).end());
});

function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  if (event.source.userId === targetUserId) {
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

// 日本時間8:00 → UTCで23:00に設定
schedule.scheduleJob('0 23 * * *', () => {
  console.log('⏰ 8:00 (JST) - Wakeup Botスタート');
  startWakeupMessages();
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
