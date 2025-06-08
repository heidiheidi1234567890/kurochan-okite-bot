// LINE Wakeup Bot with Database Support and Enhanced Security (Node.js)

const express = require('express');
const bodyParser = require('body-parser');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const schedule = require('node-schedule');
const dayjs = require('dayjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

dotenv.config();

const app = express();

// セキュリティミドルウェア
app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100 // 最大100リクエスト
}));

app.use(bodyParser.json({ type: '*/*' }));

// 環境変数の検証
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'TARGET_USER_ID'
];

requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ 環境変数 ${varName} が設定されていません`);
    process.exit(1);
  }
});

// オプショナル環境変数の警告
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL が設定されていません。メモリストレージを使用します。');
}

if (!process.env.NOTIFY_USER_IDS) {
  console.warn('⚠️ NOTIFY_USER_IDS が設定されていません。通知機能が無効です。');
}

if (!process.env.ADMIN_USER_IDS) {
  console.warn('⚠️ ADMIN_USER_IDS が設定されていません。管理コマンドが無効です。');
}

// LINE設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const targetUserId = process.env.TARGET_USER_ID;
const notifyUserIds = process.env.NOTIFY_USER_IDS?.split(',').filter(id => id.trim()) || [];
const adminUserIds = process.env.ADMIN_USER_IDS?.split(',').filter(id => id.trim()) || [];

// データベース設定
let pool = null;
let useDatabase = false;

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    useDatabase = true;
    console.log('✅ データベース設定を検出しました');
  } catch (error) {
    console.warn('⚠️ データベース設定エラー、ファイルストレージにフォールバック:', error.message);
  }
} else {
  console.log('ℹ️ データベース未設定、メモリストレージを使用します');
}

// メモリベースのストレージ（データベースが利用できない場合）
let memoryStorage = {
  excludeDates: [],
  customTimes: {},
  logs: []
};

let intervalId = null;
let hasResponded = false;
let displayNameCache = {};

// データベース初期化
async function initializeDatabase() {
  if (!useDatabase) {
    console.log('✅ メモリストレージ初期化完了');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedule_settings (
        id SERIAL PRIMARY KEY,
        date VARCHAR(10) UNIQUE NOT NULL,
        is_excluded BOOLEAN DEFAULT FALSE,
        custom_hour INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_logs (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        user_id VARCHAR(100),
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('✅ データベース初期化完了');
  } catch (error) {
    console.warn('⚠️ データベース初期化エラー、メモリストレージにフォールバック:', error.message);
    useDatabase = false;
    pool = null;
  }
}

// スケジュール管理
async function loadSchedule() {
  if (!useDatabase) {
    return {
      exclude: memoryStorage.excludeDates,
      change: memoryStorage.customTimes
    };
  }

  try {
    const excludeResult = await pool.query(
      'SELECT date FROM schedule_settings WHERE is_excluded = TRUE'
    );
    const changeResult = await pool.query(
      'SELECT date, custom_hour FROM schedule_settings WHERE custom_hour IS NOT NULL'
    );
    
    const exclude = excludeResult.rows.map(row => row.date);
    const change = {};
    changeResult.rows.forEach(row => {
      change[row.date] = row.custom_hour.toString();
    });
    
    return { exclude, change };
  } catch (error) {
    console.error('スケジュール読み込みエラー:', error);
    return { exclude: [], change: {} };
  }
}

async function addExcludeDate(date) {
  if (!useDatabase) {
    if (!memoryStorage.excludeDates.includes(date)) {
      memoryStorage.excludeDates.push(date);
    }
    return;
  }

  try {
    await pool.query(`
      INSERT INTO schedule_settings (date, is_excluded) 
      VALUES ($1, TRUE) 
      ON CONFLICT (date) 
      DO UPDATE SET is_excluded = TRUE, updated_at = NOW()
    `, [date]);
  } catch (error) {
    console.error('除外日追加エラー:', error);
    throw error;
  }
}

async function removeExcludeDate(date) {
  if (!useDatabase) {
    memoryStorage.excludeDates = memoryStorage.excludeDates.filter(d => d !== date);
    return;
  }

  try {
    await pool.query(
      'UPDATE schedule_settings SET is_excluded = FALSE, updated_at = NOW() WHERE date = $1',
      [date]
    );
  } catch (error) {
    console.error('除外日削除エラー:', error);
    throw error;
  }
}

async function setCustomTime(date, hour) {
  if (!useDatabase) {
    memoryStorage.customTimes[date] = hour.toString();
    return;
  }

  try {
    await pool.query(`
      INSERT INTO schedule_settings (date, custom_hour) 
      VALUES ($1, $2) 
      ON CONFLICT (date) 
      DO UPDATE SET custom_hour = $2, updated_at = NOW()
    `, [date, parseInt(hour)]);
  } catch (error) {
    console.error('カスタム時間設定エラー:', error);
    throw error;
  }
}

// ログ記録
async function logEvent(eventType, userId = null, message = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventType,
    userId,
    message
  };

  if (!useDatabase) {
    memoryStorage.logs.push(logEntry);
    // メモリ使用量制限のため、最新1000件のみ保持
    if (memoryStorage.logs.length > 1000) {
      memoryStorage.logs = memoryStorage.logs.slice(-1000);
    }
    console.log(`📝 [${eventType}] ${userId || 'system'}: ${message || ''}`);
    return;
  }

  try {
    await pool.query(
      'INSERT INTO bot_logs (event_type, user_id, message) VALUES ($1, $2, $3)',
      [eventType, userId, message]
    );
  } catch (error) {
    console.error('ログ記録エラー:', error);
    // データベースエラーの場合、コンソールに出力
    console.log(`📝 [${eventType}] ${userId || 'system'}: ${message || ''}`);
  }
}

// ユーザー名取得（キャッシュ付き）
async function getDisplayName(userId) {
  if (displayNameCache[userId]) {
    return displayNameCache[userId];
  }
  
  try {
    const profile = await client.getProfile(userId);
    displayNameCache[userId] = profile.displayName;
    return profile.displayName;
  } catch (error) {
    console.error('プロフィール取得エラー:', error);
    return `User(${userId.slice(-8)})`;
  }
}

// 起床メッセージ送信
async function sendWakeupMessage() {
  try {
    await client.pushMessage(targetUserId, {
      type: 'text',
      text: 'おはよう〜！起きてる？？👀'
    });
    await logEvent('wakeup_sent', targetUserId);
  } catch (error) {
    console.error('起床メッセージ送信エラー:', error);
    await logEvent('wakeup_error', targetUserId, error.message);
  }
}

// 起床メッセージ開始
async function startWakeupMessages(startHour) {
  hasResponded = false;
  await sendWakeupMessage();
  
  // 5分間隔でリマインダー
  intervalId = setInterval(async () => {
    if (!hasResponded) {
      await sendWakeupMessage();
    }
  }, 5 * 60 * 1000);
  
  // 1時間後にタイムアウト処理
  setTimeout(async () => {
    clearInterval(intervalId);
    if (!hasResponded) {
      try {
        const name = await getDisplayName(targetUserId);
        const message = `⚠️ ${name} は1時間返事がありませんでした…`;
        
        for (const uid of notifyUserIds) {
          await client.pushMessage(uid, {
            type: 'text',
            text: message
          });
        }
        
        await logEvent('timeout_notification', targetUserId);
      } catch (error) {
        console.error('タイムアウト通知エラー:', error);
      }
    }
  }, 60 * 60 * 1000);
}

// コマンド処理
async function handleCommand(event) {
  const { text } = event.message;
  const userId = event.source.userId;
  
  try {
    console.log(`🎮 コマンド処理開始: "${text}" from ${userId}`);
    await logEvent('command_received', userId, text);
    
    // 管理者権限チェック
    if (!adminUserIds.includes(userId)) {
      console.log(`🚫 非管理者からのアクセス: ${userId}`);
      
      // replyTokenが存在する場合のみ返信
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '申し訳ありませんが、このアカウントでは個別のお問い合わせを受け付けておりません。次の配信までお待ちください'
        });
      }
      return;
    }
    
    console.log(`✅ 管理者アクセス確認: ${userId}`);
    const schedule = await loadSchedule();
    
    // コマンド処理
    if (text === '一覧') {
      const excludeList = schedule.exclude.length > 0 ? schedule.exclude.join(', ') : 'なし';
      const changeList = Object.entries(schedule.change).length > 0 
        ? Object.entries(schedule.change).map(([d, t]) => `${d} → ${t}時`).join(', ') 
        : 'なし';
      
      const listText = `📅 スケジュール設定\n\n除外日: ${excludeList}\n変更日: ${changeList}`;
      
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: listText
        });
      }
      console.log('📋 一覧表示完了');
      return;
    }
    
    if (text.startsWith('除外 ')) {
      const date = text.split(' ')[1];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '❌ 日付の形式が正しくありません。YYYY-MM-DD形式で入力してください。'
          });
        }
        return;
      }
      
      await addExcludeDate(date);
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ ${date} を除外日に追加しました。`
        });
      }
      console.log(`📅 除外日追加: ${date}`);
      return;
    }
    
    if (text.startsWith('除外削除 ')) {
      const date = text.split(' ')[1];
      await removeExcludeDate(date);
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ ${date} を除外日から削除しました。`
        });
      }
      console.log(`📅 除外日削除: ${date}`);
      return;
    }
    
    if (text.startsWith('変更 ')) {
      const parts = text.split(' ');
      const date = parts[1];
      const hour = parts[2];
      
      if (!date || !hour || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(hour) || hour < 0 || hour > 23) {
        if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '❌ 形式が正しくありません。例: 変更 2024-01-01 9'
          });
        }
        return;
      }
      
      await setCustomTime(date, hour);
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ ${date} の起動時刻を ${hour} 時に変更しました。`
        });
      }
      console.log(`⏰ 時刻変更: ${date} → ${hour}時`);
      return;
    }
    
    // ヘルプメッセージ
    if (text === 'ヘルプ' || text === 'help') {
      const helpText = `🤖 コマンド一覧\n\n` +
        `一覧 - 現在の設定を表示\n` +
        `除外 YYYY-MM-DD - 指定日を除外\n` +
        `除外削除 YYYY-MM-DD - 除外日を削除\n` +
        `変更 YYYY-MM-DD 時間 - 起動時刻を変更\n` +
        `ヘルプ - このメッセージを表示`;
      
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: helpText
        });
      }
      console.log('❓ ヘルプ表示完了');
      return;
    }
    
    console.log(`ℹ️ 未知のコマンド: ${text}`);
    
  } catch (error) {
    console.error('❌ コマンド処理エラー:', error);
    console.error('Error details:', error.stack);
    
    try {
      if (event.replyToken && event.replyToken !== '00000000000000000000000000000000') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ エラーが発生しました。しばらく後でお試しください。'
        });
      }
    } catch (replyError) {
      console.error('❌ エラー返信失敗:', replyError);
    }
    
    await logEvent('command_error', userId, `${text}: ${error.message}`);
  }
}

// Webhook処理
app.post('/webhook', line.middleware(config), async (req, res) => {
  console.log('🔄 Webhook受信:', JSON.stringify(req.body, null, 2));
  
  try {
    // イベントが存在しない場合の対応
    if (!req.body.events || req.body.events.length === 0) {
      console.log('ℹ️ イベントなし、200で応答');
      res.status(200).end();
      return;
    }

    await Promise.all(req.body.events.map(async (event) => {
      console.log(`📥 イベント処理: ${event.type}`, event);
      
      try {
        if (event.type === 'message' && event.message.type === 'text') {
          console.log(`💬 テキストメッセージ: ${event.message.text} from ${event.source.userId}`);
          
          // コマンド処理
          await handleCommand(event);
          
          // ターゲットユーザーからの返信処理
          if (event.source.userId === targetUserId) {
            console.log('🎯 ターゲットユーザーからの返信');
            hasResponded = true;
            clearInterval(intervalId);
            
            try {
              const name = await getDisplayName(targetUserId);
              const message = `🟢 ${name} が返信しました！`;
              
              if (notifyUserIds.length > 0) {
                await Promise.all(notifyUserIds.map(uid => 
                  client.pushMessage(uid, {
                    type: 'text',
                    text: message
                  })
                ));
                console.log(`📤 通知送信完了: ${notifyUserIds.length}人`);
              }
              
              await logEvent('user_responded', targetUserId);
            } catch (error) {
              console.error('返信通知エラー:', error);
              await logEvent('notification_error', targetUserId, error.message);
            }
          }
        } else if (event.type === 'follow') {
          console.log('👋 新しいフォロー:', event.source.userId);
          await logEvent('user_follow', event.source.userId);
        } else if (event.type === 'unfollow') {
          console.log('👋 アンフォロー:', event.source.userId);
          await logEvent('user_unfollow', event.source.userId);
        } else {
          console.log(`ℹ️ 未対応イベント: ${event.type}`);
        }
      } catch (eventError) {
        console.error(`❌ イベント処理エラー [${event.type}]:`, eventError);
        await logEvent('event_error', event.source?.userId, `${event.type}: ${eventError.message}`);
      }
    }));
    
    console.log('✅ Webhook処理完了、200で応答');
    res.status(200).end();
  } catch (error) {
    console.error('❌ Webhook処理エラー:', error);
    console.error('Error stack:', error.stack);
    await logEvent('webhook_error', null, error.message);
    
    // エラーでも200を返す（LINEの推奨）
    res.status(200).end();
  }
});

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LINE Wakeup Bot',
    timestamp: new Date().toISOString()
  });
});

// Webhook検証用エンドポイント
app.get('/webhook', (req, res) => {
  console.log('📞 Webhook GET request received');
  res.status(200).send('Webhook endpoint is working');
});

// デバッグ用エンドポイント
app.get('/debug', async (req, res) => {
  try {
    const schedule = await loadSchedule();
    const debugInfo = {
      timestamp: new Date().toISOString(),
      server: {
        port: port,
        nodeEnv: process.env.NODE_ENV,
        storage: useDatabase ? 'database' : 'memory'
      },
      config: {
        targetUserId: targetUserId ? `${targetUserId.slice(0, 8)}...` : 'not_set',
        notifyUsers: notifyUserIds.length,
        adminUsers: adminUserIds.length,
        hasDatabase: !!process.env.DATABASE_URL
      },
      schedule: schedule,
      memory: useDatabase ? null : memoryStorage,
      botStatus: {
        hasResponded: hasResponded,
        intervalActive: !!intervalId
      }
    };
    
    res.json(debugInfo);
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/health', async (req, res) => {
  try {
    if (useDatabase) {
      await pool.query('SELECT 1');
      res.json({ 
        status: 'healthy', 
        database: 'connected',
        storage: 'database'
      });
    } else {
      res.json({ 
        status: 'healthy', 
        database: 'not_configured',
        storage: 'memory',
        excludeDates: memoryStorage.excludeDates.length,
        customTimes: Object.keys(memoryStorage.customTimes).length,
        logs: memoryStorage.logs.length
      });
    }
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      database: 'disconnected',
      error: error.message 
    });
  }
});

// スケジューラー（毎分チェック、より精密な制御）
schedule.scheduleJob('*/1 * * * *', async () => {
  const now = dayjs();
  
  try {
    const schedule = await loadSchedule();
    const today = now.format('YYYY-MM-DD');
    
    // 除外日チェック
    if (schedule.exclude.includes(today)) {
      return;
    }
    
    // 起動時刻決定
    const startHour = schedule.change[today] || '8';
    
    // 正確な時刻チェック（秒も考慮）
    if (now.hour() === Number(startHour) && now.minute() === 0 && now.second() < 10) {
      console.log(`⏰ ${startHour}:00 - Wakeup Botスタート (${today})`);
      await logEvent('bot_started', null, `Start time: ${startHour}:00`);
      await startWakeupMessages(startHour);
    }
  } catch (error) {
    console.error('スケジューラーエラー:', error);
    await logEvent('scheduler_error', null, error.message);
  }
});

// サーバー起動
const port = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
      console.log(`💾 Storage: ${useDatabase ? 'Database (PostgreSQL)' : 'Memory (temporary)'}`);
      console.log(`📱 Target User: ${targetUserId}`);
      console.log(`👥 Notify Users: ${notifyUserIds.length} users`);
      console.log(`👑 Admin Users: ${adminUserIds.length} users`);
      
      if (!useDatabase) {
        console.log('⚠️  注意: メモリストレージを使用中。再起動でデータが消失します。');
        console.log('   データベースを使用するには DATABASE_URL 環境変数を設定してください。');
      }
    });
  } catch (error) {
    console.error('❌ サーバー起動エラー:', error);
    process.exit(1);
  }
}

// グレースフルシャットダウン
process.on('SIGTERM', async () => {
  console.log('SIGTERM受信、サーバーを終了します...');
  clearInterval(intervalId);
  if (useDatabase && pool) {
    await pool.end();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT受信、サーバーを終了します...');
  clearInterval(intervalId);
  if (useDatabase && pool) {
    await pool.end();
  }
  process.exit(0);
});

startServer();
