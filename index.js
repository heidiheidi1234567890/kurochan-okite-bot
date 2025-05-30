// LINE Wakeup Bot (Node.js) - 毎朝8時に起動、5分おきにメッセージ、1時間で終了

const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const fs = require('fs');
const schedule = require('node-schedule');

dotenv.config();

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

const targetUserId = process.env.TARGET_USER_ID;
const notifyUserIds = process.env.NOTIFY_USER_IDS?.split(',') || [];

let intervalId = null;
let hasResponded = false;

// スケジュール設定の読み書き
const SCHEDULE_FILE = 'schedule.json';
function loadSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE));
  } catch {
    return { exclude: [], change: {} };
  }
}
function saveSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

function startWakeupMessages() {
  hasResponded = false;
  sendWakeupMessage();
  intervalId = setInterval(() => {
    if (!hasResponded) {
      sendWakeupMessage();
    }
  }, 5 * 60 * 1000);

  setTimeout(() => {
    clearInterval(intervalId);
    if (!hasResponded) {
      notifyUserIds.forEach(uid => {
        client.pushMessage(uid, {
          type: 'text',
          text: `⚠️ ${targetUserId} は心地良く眠りについています…`
        });
      });
    }
  }, 60 * 60 * 1000);
}

function sendWakeupMessage() {
  client.pushMessage(targetUserId, {
    type: 'text',
    text: 'おはよう〜！👀'
  });
}

// LINE Webhook用（署名チェックあり）
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error('Webhook Error:', err);
      res.status(500).end();
    });
});

// 他のルート用
app.use(express.json());

app.get('/', (req, res) => res.send('LINE Wakeup Bot Running'));

function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const msg = event.message.text.trim();
  const scheduleData = loadSchedule();

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

  // 除外追加
  if (msg.startsWith('除外:')) {
    const date = msg.slice(3).trim();
    if (!scheduleData.exclude.includes(date)) {
      scheduleData.exclude.push(date);
      saveSchedule(scheduleData);
    }
    return reply(event.replyToken, `🗓️ 除外日に追加しました: ${date}`);
  }

  // 除外削除
  if (msg.startsWith('除外削除:')) {
    const date = msg.slice(5).trim();
    scheduleData.exclude = scheduleData.exclude.filter(d => d !== date);
    saveSchedule(scheduleData);
    return reply(event.replyToken, `🗑️ 除外日を削除しました: ${date}`);
  }

  // 変更追加（例：変更:2025-06-01 07:30）
  if (msg.startsWith('変更:')) {
    const [date, time] = msg.slice(3).trim().split(' ');
    if (date && time) {
      scheduleData.change[date] = time;
      saveSchedule(scheduleData);
      return reply(event.replyToken, `⏰ ${date} の起動時刻を ${time} に設定しました。`);
    }
  }

  // 変更削除
  if (msg.startsWith('変更削除:')) {
    const date = msg.slice(5).trim();
    delete scheduleData.change[date];
    saveSchedule(scheduleData);
    return reply(event.replyToken, `🗑️ 起動変更を削除しました: ${date}`);
  }

  // 一覧表示
  if (msg === '一覧') {
    const excludeList = scheduleData.exclude.join('\n') || '（なし）';
    const changeList = Object.entries(scheduleData.change).map(([d, t]) => `${d} → ${t}`).join('\n') || '（なし）';
    return reply(event.replyToken,
      `📅 除外日一覧:\n${excludeList}\n\n⏰ 起動変更一覧:\n${changeList}`);
  }

  return Promise.resolve(null);
}

function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

// スケジュール起動（毎日）
schedule.scheduleJob('0 0 * * *', () => { // UTC 0:00 = JST 9:00
  const today = new Date();
  const jst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
  const yyyyMMdd = jst.toISOString().slice(0, 10);

  const scheduleData = loadSchedule();
  if (scheduleData.exclude.includes(yyyyMMdd)) {
    console.log(`🚫 ${yyyyMMdd} は除外日です。起動しません。`);
    return;
  }

  let hour = 8;
  let minute = 0;
  if (scheduleData.change[yyyyMMdd]) {
    const [h, m] = scheduleData.change[yyyyMMdd].split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      hour = h;
      minute = m;
    }
  }

  const trigger = new Date(jst);
  trigger.setHours(hour);
  trigger.setMinutes(minute);
  trigger.setSeconds(0);

  console.log(`🕓 Wakeup Bot will start at ${trigger.toLocaleTimeString('ja-JP')} on ${yyyyMMdd}`);

  schedule.scheduleJob(trigger, () => {
    console.log(`⏰ ${yyyyMMdd} - Wakeup Botスタート (${hour}:${minute})`);
    startWakeupMessages();
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
