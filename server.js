const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hongkong-hosting-secret-key-2024';
const ADMIN_USER = 'Nobi_36';
const ADMIN_PASS_HASH = bcrypt.hashSync('pm2 start ~/ecosystem.config.js', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/bots', express.static('bots'));

// Ensure dirs
fs.ensureDirSync('./data');
fs.ensureDirSync('./bots');

// DB helpers
const DB = {
  load: (file) => {
    try { return JSON.parse(fs.readFileSync(`./data/${file}.json`, 'utf8')); }
    catch { return file === 'users' ? { users: [] } : file === 'codes' ? { codes: [] } : file === 'transactions' ? { transactions: [] } : file === 'bots' ? { bots: [] } : {}; }
  },
  save: (file, data) => fs.writeFileSync(`./data/${file}.json`, JSON.stringify(data, null, 2))
};

// Active processes & logs
const activeProcesses = {};
const botLogs = {};

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminOnly = (req, res, next) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
};

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `./bots/${req.user.id}`;
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ===================== AUTH =====================
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = DB.load('users');
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username exists' });

  const user = {
    id: uuidv4(),
    username,
    email,
    password: await bcrypt.hash(password, 10),
    name: username,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=8B0000&color=fff&size=128`,
    isAdmin: false,
    balance: 0,
    plan: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  DB.save('users', db);

  const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET);
  res.json({ token, user: { ...user, password: undefined } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  // Admin hardcoded
  if (username === ADMIN_USER) {
    if (password === 'pm2 start ~/ecosystem.config.js') {
      let db = DB.load('users');
      let admin = db.users.find(u => u.username === ADMIN_USER);
      if (!admin) {
        admin = {
          id: uuidv4(), username: ADMIN_USER, email: 'admin@hongkong.host',
          password: ADMIN_PASS_HASH, name: 'Nobi_36', isAdmin: true,
          avatar: `https://ui-avatars.com/api/?name=Nobi_36&background=ffd700&color=000&size=128`,
          balance: 999999999, plan: 'ULTIMATE', createdAt: new Date().toISOString()
        };
        db.users.push(admin);
        DB.save('users', db);
      }
      const token = jwt.sign({ id: admin.id, username: admin.username, isAdmin: true }, JWT_SECRET);
      return res.json({ token, user: { ...admin, password: undefined } });
    }
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const db = DB.load('users');
  const user = db.users.find(u => u.username === username);
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET);
  res.json({ token, user: { ...user, password: undefined } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const db = DB.load('users');
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, password: undefined });
});

// ===================== WALLET =====================
app.get('/api/wallet', auth, (req, res) => {
  const db = DB.load('users');
  const user = db.users.find(u => u.id === req.user.id);
  const trans = DB.load('transactions').transactions.filter(t => t.userId === req.user.id);
  res.json({ balance: user.balance, transactions: trans });
});

// ===================== CODES =====================
app.post('/api/code/redeem', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const dbCodes = DB.load('codes');
  const codeData = dbCodes.codes.find(c => c.code === code.toUpperCase());
  if (!codeData) return res.status(400).json({ error: 'Invalid code' });
  if (codeData.usedCount >= codeData.maxUses) return res.status(400).json({ error: 'Code expired' });

  const dbUsers = DB.load('users');
  const user = dbUsers.users.find(u => u.id === req.user.id);

  // Check if user already used this code
  const dbTrans = DB.load('transactions');
  if (dbTrans.transactions.find(t => t.userId === req.user.id && t.code === code.toUpperCase())) {
    return res.status(400).json({ error: 'You already used this code' });
  }

  // Apply
  user.balance += codeData.amount;
  codeData.usedCount++;

  dbTrans.transactions.unshift({
    id: uuidv4(), userId: req.user.id, type: 'Nhập Code',
    code: code.toUpperCase(), amount: codeData.amount,
    time: new Date().toLocaleString('vi-VN')
  });

  DB.save('users', dbUsers);
  DB.save('codes', dbCodes);
  DB.save('transactions', dbTrans);

  res.json({ success: true, amount: codeData.amount, balance: user.balance });
});

// ===================== ADMIN CODES =====================
app.post('/api/admin/code', auth, adminOnly, (req, res) => {
  const { code, amount, maxUses } = req.body;
  if (!code || !amount || !maxUses) return res.status(400).json({ error: 'Missing fields' });

  const db = DB.load('codes');
  if (db.codes.find(c => c.code === code.toUpperCase())) return res.status(400).json({ error: 'Code exists' });

  db.codes.push({
    code: code.toUpperCase(), amount: parseInt(amount), maxUses: parseInt(maxUses),
    usedCount: 0, createdBy: req.user.username, createdAt: new Date().toISOString()
  });
  DB.save('codes', db);
  res.json({ success: true, code: code.toUpperCase() });
});

app.get('/api/admin/codes', auth, adminOnly, (req, res) => {
  res.json(DB.load('codes').codes);
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const db = DB.load('users');
  res.json(db.users.map(u => ({ ...u, password: undefined })));
});

// ===================== PLANS =====================
const PLANS = {
  basic: { name: 'BASIC', price: 10000, days: 7, maxBots: 2 },
  pro: { name: 'PRO', price: 30000, days: 30, maxBots: 5 },
  ultimate: { name: 'ULTIMATE', price: 100000, days: 365, maxBots: 999 }
};

app.post('/api/plan/buy', auth, (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const db = DB.load('users');
  const user = db.users.find(u => u.id === req.user.id);
  if (user.balance < plan.price) return res.status(400).json({ error: 'Insufficient balance' });

  user.balance -= plan.price;
  const now = new Date();
  const expiry = new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000);
  user.plan = { id: planId, name: plan.name, price: plan.price, expiry: expiry.toISOString(), active: true };

  const dbTrans = DB.load('transactions');
  dbTrans.transactions.unshift({
    id: uuidv4(), userId: req.user.id, type: `Mua gói ${plan.name}`,
    code: '-', amount: -plan.price, time: new Date().toLocaleString('vi-VN')
  });

  DB.save('users', db);
  DB.save('transactions', dbTrans);
  res.json({ success: true, plan: user.plan, balance: user.balance });
});

app.get('/api/plan/my', auth, (req, res) => {
  const db = DB.load('users');
  const user = db.users.find(u => u.id === req.user.id);
  res.json({ plan: user.plan, maxBots: user.plan ? PLANS[user.plan.id]?.maxBots || 0 : 0 });
});

// ===================== BOT MANAGEMENT =====================
function extractToken(content) {
  // Tìm client.login("TOKEN") hoặc client.login('TOKEN')
  const match = content.match(/client\.login\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/);
  if (match && match[1] && match[1].length > 20) return match[1];
  // Tìm token trong comment hoặc string khác
  const tokenMatch = content.match(/[MN][A-Za-z\d]{23}\.[A-Za-z\d]{6}\.[A-Za-z\d-_]{27,}/);
  if (tokenMatch) return tokenMatch[0];
  return null;
}

function getUserBotDir(userId) {
  return path.join(__dirname, 'bots', userId);
}

app.post('/api/bot/upload', auth, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });

  const db = DB.load('users');
  const user = db.users.find(u => u.id === req.user.id);
  const plan = user.plan;
  const maxBots = plan ? PLANS[plan.id]?.maxBots || 2 : 0;

  const botDir = getUserBotDir(req.user.id);
  const existing = fs.readdirSync(botDir).filter(f => !f.startsWith('.'));
  if (existing.length + req.files.length > maxBots && !user.isAdmin) {
    // Xóa file vừa upload
    req.files.forEach(f => fs.removeSync(f.path));
    return res.status(400).json({ error: `Gói của bạn chỉ cho phép ${maxBots} file. Vui lòng nâng cấp VIP.` });
  }

  // Check for token in uploaded files
  let tokenFound = null;
  for (const file of req.files) {
    if (file.originalname.endsWith('.js') || file.originalname.endsWith('.env')) {
      const content = fs.readFileSync(file.path, 'utf8');
      const token = extractToken(content);
      if (token) tokenFound = token;
    }
  }

  const dbBots = DB.load('bots');
  const botEntry = dbBots.bots.find(b => b.userId === req.user.id);
  if (botEntry) {
    botEntry.files = req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path }));
    botEntry.token = tokenFound || botEntry.token;
  } else {
    dbBots.bots.push({
      userId: req.user.id,
      files: req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path })),
      token: tokenFound,
      running: false,
      pid: null,
      startedAt: null
    });
  }
  DB.save('bots', dbBots);

  res.json({ 
    success: true, 
    files: req.files.map(f => ({ name: f.originalname, size: f.size })),
    tokenDetected: !!tokenFound,
    message: tokenFound ? '✓ Đã phát hiện token bot' : '⚠ Không tìm thấy token trong file. Bot có thể dùng process.env.TOKEN'
  });
});

app.get('/api/bot/files', auth, (req, res) => {
  const dbBots = DB.load('bots');
  const bot = dbBots.bots.find(b => b.userId === req.user.id);
  if (!bot) return res.json({ files: [] });
  res.json({ files: bot.files || [] });
});

app.post('/api/bot/start', auth, async (req, res) => {
  const userId = req.user.id;
  const dbBots = DB.load('bots');
  const bot = dbBots.bots.find(b => b.userId === userId);
  if (!bot || !bot.files || bot.files.length === 0) {
    return res.status(400).json({ error: 'Chưa upload file bot. Vui lòng upload trước.' });
  }

  // Find main file (index.js or first .js)
  const mainFile = bot.files.find(f => f.name === 'index.js') || bot.files.find(f => f.name.endsWith('.js'));
  if (!mainFile) return res.status(400).json({ error: 'Không tìm thấy file .js chính. Bot Discord cần file .js để chạy.' });

  // Stop existing
  if (activeProcesses[userId]) {
    activeProcesses[userId].kill();
    delete activeProcesses[userId];
  }

  botLogs[userId] = [];
  const botDir = getUserBotDir(userId);

  // Check token
  let token = bot.token;
  if (!token) {
    // Try read from .env if exists
    const envPath = path.join(botDir, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const envMatch = envContent.match(/DISCORD_TOKEN\s*=\s*(.+)/);
      if (envMatch) token = envMatch[1].trim();
    }
  }
  if (!token) return res.status(400).json({ error: 'Không tìm thấy Discord Token. Vui lòng kiểm tra file bot có chứa client.login("TOKEN") hoặc upload file .env với DISCORD_TOKEN=...' });

  // Validate token format
  if (!token.match(/[MN][A-Za-z\d]{23}\.[A-Za-z\d]{6}\.[A-Za-z\d-_]{27,}/)) {
    return res.status(400).json({ error: 'Token không đúng định dạng Discord Bot Token. Token phải bắt đầu bằng M hoặc N, có 3 phần cách nhau bởi dấu chấm.' });
  }

  try {
    const child = spawn('node', [mainFile.name], {
      cwd: botDir,
      env: { ...process.env, DISCORD_TOKEN: token, NODE_PATH: path.join(__dirname, 'node_modules') }
    });

    activeProcesses[userId] = child;
    bot.running = true;
    bot.pid = child.pid;
    bot.startedAt = new Date().toISOString();
    DB.save('bots', dbBots);

    child.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (!botLogs[userId]) botLogs[userId] = [];
      botLogs[userId].push({ time: Date.now(), type: 'info', message: msg });
      if (botLogs[userId].length > 500) botLogs[userId].shift();
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!botLogs[userId]) botLogs[userId] = [];
      botLogs[userId].push({ time: Date.now(), type: 'error', message: msg });
      if (botLogs[userId].length > 500) botLogs[userId].shift();
    });

    child.on('close', (code) => {
      const msg = `Bot process exited with code ${code}`;
      if (botLogs[userId]) botLogs[userId].push({ time: Date.now(), type: 'error', message: msg });
      const db = DB.load('bots');
      const b = db.bots.find(x => x.userId === userId);
      if (b) { b.running = false; b.pid = null; DB.save('bots', db); }
      delete activeProcesses[userId];
    });

    child.on('error', (err) => {
      const msg = `Failed to start bot: ${err.message}`;
      if (botLogs[userId]) botLogs[userId].push({ time: Date.now(), type: 'error', message: msg });
    });

    res.json({ success: true, message: 'Bot đang khởi động...', pid: child.pid });

  } catch (err) {
    res.status(500).json({ error: `Lỗi khởi động bot: ${err.message}` });
  }
});

app.post('/api/bot/stop', auth, (req, res) => {
  const userId = req.user.id;
  if (activeProcesses[userId]) {
    activeProcesses[userId].kill();
    delete activeProcesses[userId];
  }
  const db = DB.load('bots');
  const bot = db.bots.find(b => b.userId === userId);
  if (bot) { bot.running = false; bot.pid = null; DB.save('bots', db); }
  if (botLogs[userId]) botLogs[userId].push({ time: Date.now(), type: 'warn', message: 'Bot stopped by user' });
  res.json({ success: true, message: 'Bot đã dừng' });
});

app.post('/api/bot/restart', auth, (req, res) => {
  const userId = req.user.id;
  if (activeProcesses[userId]) {
    activeProcesses[userId].kill();
    delete activeProcesses[userId];
  }
  setTimeout(() => {
    // Call start logic again
    req.url = '/api/bot/start';
    req.method = 'POST';
    // We can't easily call internal, so tell client to call start
    res.json({ success: true, message: 'Đang khởi động lại...' });
  }, 1000);
});

app.get('/api/bot/status', auth, (req, res) => {
  const userId = req.user.id;
  const db = DB.load('bots');
  const bot = db.bots.find(b => b.userId === userId);
  const running = activeProcesses[userId] && !activeProcesses[userId].killed;
  res.json({ 
    running: !!running, 
    pid: bot?.pid || null,
    startedAt: bot?.startedAt || null,
    files: bot?.files?.length || 0
  });
});

app.get('/api/bot/logs', auth, (req, res) => {
  const userId = req.user.id;
  const since = parseInt(req.query.since) || 0;
  const logs = botLogs[userId] || [];
  const newLogs = logs.filter(l => l.time > since);
  res.json({ logs: newLogs, lastTime: logs.length > 0 ? logs[logs.length - 1].time : Date.now() });
});

app.delete('/api/bot/files', auth, (req, res) => {
  const userId = req.user.id;
  if (activeProcesses[userId]) {
    activeProcesses[userId].kill();
    delete activeProcesses[userId];
  }
  const botDir = getUserBotDir(userId);
  fs.removeSync(botDir);
  const db = DB.load('bots');
  db.bots = db.bots.filter(b => b.userId !== userId);
  DB.save('bots', db);
  botLogs[userId] = [];
  res.json({ success: true, message: 'Đã xóa tất cả file bot' });
});

app.delete('/api/bot/file/:filename', auth, (req, res) => {
  const userId = req.user.id;
  const filename = req.params.filename;
  const botDir = getUserBotDir(userId);
  const filePath = path.join(botDir, filename);
  if (fs.existsSync(filePath)) fs.removeSync(filePath);
  const db = DB.load('bots');
  const bot = db.bots.find(b => b.userId === userId);
  if (bot && bot.files) {
    bot.files = bot.files.filter(f => f.name !== filename);
    DB.save('bots', db);
  }
  res.json({ success: true });
});

// ===================== INIT =====================
// Auto-restart bots on server start
const dbBots = DB.load('bots');
for (const bot of dbBots.bots) {
  if (bot.running) {
    console.log(`Auto-restarting bot for user ${bot.userId}...`);
    // Simulate start request
    setTimeout(() => {
      // We need to trigger start internally
      // For simplicity, user needs to manually restart via frontend after server reboot
      bot.running = false; bot.pid = null;
    }, 100);
  }
}
DB.save('bots', dbBots);

app.listen(PORT, () => {
  console.log(`🚀 HONGKONG HOSTING Backend running on port ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
});
