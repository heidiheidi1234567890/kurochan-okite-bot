// LINE Wakeup Bot with Exclusion and Custom Time Support (Node.js)

const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const fs = require('fs');
const schedule = require('node-schedule');
const dayjs = require('dayjs');

dotenv.config();

const app = express();
app.use(bodyParser.json({ type: '*/*' }));

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const targetUserId = process.env.TARGET_USER_ID;
const notifyUserIds = process.env.NOTIFY_USER_IDS?.split(',') || [];
const adminUserIds = process.env.ADMIN_USER_IDS?.split(',') || [];

let intervalId = null;
let hasResponded = false;
let displayNameCache = {};

const SCHEDULE_FILE = 'schedule.json';
function loadSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) return { exclude: [], change: {} };
  return JSON.parse(fs.readFileSync(SCHEDULE_FILE));
}

function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

function getDisplayName(userId) {
  if (displayNameCache[userId]) return Promise.resolve(displayNameCache[userId]);
  return client.getProfile(userId).then(profile => {
    displayNameCache[userId] = profile.displayName;
    return profile.displayName;
  }).catch(() => userId);
}

function sendWakeupMessage() {
  client.pushMessage(targetUserId, {
    type: 'text',
    text: 'おはよう〜！起きてる？？👀'
  });
}

function startWakeupMessages(startHour) {
  hasResponded = false;
  sendWakeupMessage();

  intervalId = setInterval(() => {
    if (!hasResponded) sendWakeupMessage();
  }, 5 * 60 * 1000);

  setTimeout(() => {
    clearInterval(intervalId);
    if (!hasResponded) {
      getDisplayName(targetUserId).then(name => {
        notifyUserIds.forEach(uid => {
          client.pushMessage(uid, {
            type: 'text',
            text: `⚠️ ${name} は1時間返事がありませんでした…`
          });
        });
      });
    }
  }, 60 * 60 * 1000);
}

function handleCommand(event) {
  const { text } = event.message;
  const userId = event.source.userId;
  const schedule = loadSchedule();
  const today = dayjs().format('YYYY-MM-DD');

  if (!adminUserIds.includes(userId)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '申し訳ありませんが、このアカウントでは個別のお問い合わせを受け付けておりません。次の配信までお待ちください'
    });
  }

  if (text === '一覧') {
    const list = `除外日: ${schedule.exclude.join(', ') || 'なし'}\n変更日: ${Object.entries(schedule.change).map(([d, t]) => `${d} → ${t}時`).join(', ') || 'なし'}`;
    return client.replyMessage(event.replyToken, { type: 'text', text: list });
  }

  if (text.startsWith('除外 ')) {
    const date = text.split(' ')[1];
    if (!schedule.exclude.includes(date)) {
      schedule.exclude.push(date);
      saveSchedule(schedule);
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: `${date} を除外日に追加しました。` });
  }

  if (text.startsWith('除外削除 ')) {
    const date = text.split(' ')[1];
    schedule.exclude = schedule.exclude.filter(d => d !== date);
    saveSchedule(schedule);
    return client.replyMessage(event.replyToken, { type: 'text', text: `${date} を除外日から削除しました。` });
  }

  if (text.startsWith('変更 ')) {
    const [_, date, hour] = text.split(' ');
    schedule.change[date] = hour;
    saveSchedule(schedule);
    return client.replyMessage(event.replyToken, { type: 'text', text: `${date} の起動時刻を ${hour} 時に変更しました。` });
  }

  return Promise.resolve();
}

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      handleCommand(event);
      if (event.source.userId === targetUserId) {
        hasResponded = true;
        clearInterval(intervalId);
        return getDisplayName(targetUserId).then(name => {
          return Promise.all(notifyUserIds.map(uid => client.pushMessage(uid, {
            type: 'text',
            text: `🟢 ${name} が返信しました！`
          })));
        });
      }
    }
    return Promise.resolve();
  })).then(() => res.status(200).end()).catch(err => {
    console.error('Webhook error:', err);
    res.status(500).end();
  });
});

app.get('/', (req, res) => res.send('LINE Wakeup Bot Running'));

schedule.scheduleJob('*/1 * * *', () => {
  const now = dayjs();
  const schedule = loadSchedule();
  const today = now.format('YYYY-MM-DD');
  if (schedule.exclude.includes(today)) return;

  const startHour = schedule.change[today] || '8';
  if (now.hour() == Number(startHour) && now.minute() === 0) {
    console.log(`⏰ ${startHour}:00 - Wakeup Botスタート`);
    startWakeupMessages(startHour);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
