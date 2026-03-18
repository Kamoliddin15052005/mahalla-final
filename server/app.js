require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { userDB, postDB, msgDB, getMahallaId, initDB } = require('./db');
const { bot, notifyPost } = require('../bot/index');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'miniapp')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ─── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── USER ────────────────────────────────────────────────────
app.get('/api/user/:chat_id', (req, res) => {
  // 304 bo'lmasin
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const user = userDB.findByChatId(parseInt(req.params.chat_id));
  if (!user) return res.status(404).json({ error: 'Topilmadi' });
  res.json(user);
});

app.post('/api/user/location', (req, res) => {
  const { chat_id, lat, lng } = req.body;
  if (!chat_id || !lat || !lng) return res.status(400).json({ error: 'Kerakli maydonlar yo\'q' });
  userDB.updateLocation(parseInt(chat_id), parseFloat(lat), parseFloat(lng));
  res.json({ ok: true });
});

app.get('/api/mahalla/members', (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  const members = userDB.getByMahalla(mahalla_id);
  res.json(members.map(u => ({ id: u.id, full_name: u.full_name, role: u.role, chat_id: u.chat_id })));
});

// ─── POSTS ───────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  const { mahalla_id, lat, lng } = req.query;
  let posts;
  if (mahalla_id) {
    posts = postDB.getByMahalla(mahalla_id);
  } else if (lat && lng) {
    posts = postDB.getNearby(parseFloat(lat), parseFloat(lng), 3000);
  } else {
    return res.status(400).json({ error: 'mahalla_id yoki koordinat kerak' });
  }
  res.json(posts);
});

app.post('/api/posts', upload.single('photo'), async (req, res) => {
  try {
    const { chat_id, type, title, description, lat, lng } = req.body;
    if (!chat_id || !type || !description || !lat || !lng)
      return res.status(400).json({ error: 'Barcha maydonlar kerak' });

    const user = userDB.findByChatId(parseInt(chat_id));
    if (!user || !user.registered) return res.status(403).json({ error: 'Ro\'yxatdan o\'tmagan' });

    const mahalla_id = getMahallaId(parseFloat(lat), parseFloat(lng));
    const photo_path = req.file ? `/uploads/${req.file.filename}` : '';

    const result = postDB.create(user.id, type, title || '', description, parseFloat(lat), parseFloat(lng), mahalla_id, photo_path);
    const post = { id: result.lastInsertRowid, type, description, lat: parseFloat(lat), lng: parseFloat(lng), mahalla_id, photo_path };

    userDB.addScore(parseInt(chat_id), 5);
    notifyPost(post, user).catch(console.error);

    res.json({ ok: true, post_id: post.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

app.post('/api/posts/:id/resolve', (req, res) => {
  postDB.resolve(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', (req, res) => {
  const { chat_id } = req.body;
  const user = userDB.findByChatId(parseInt(chat_id));
  if (!user) return res.status(403).json({ error: 'Foydalanuvchi topilmadi' });
  const liked = postDB.like(parseInt(req.params.id), user.id);
  if (liked) userDB.addScore(parseInt(chat_id), 2);
  res.json({ ok: true, liked });
});

// ─── STATS ───────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  const stats = postDB.getStats(mahalla_id);
  const top = userDB.getTop(mahalla_id);
  res.json({ ...stats, top_users: top });
});

// ─── MESSAGES ────────────────────────────────────────────────
app.get('/api/messages/group', (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  const msgs = msgDB.getGroup(mahalla_id);
  res.json(msgs);
});

app.post('/api/messages/group', (req, res) => {
  const { chat_id, text } = req.body;
  if (!chat_id || !text?.trim()) return res.status(400).json({ error: 'chat_id va text kerak' });
  const user = userDB.findByChatId(parseInt(chat_id));
  if (!user || !user.registered) return res.status(403).json({ error: 'Ro\'yxatdan o\'tmagan' });
  msgDB.sendGroup(user.id, user.mahalla_id, text.trim());
  res.json({ ok: true });
});

app.get('/api/messages/private', (req, res) => {
  const { chat_id, contact_id } = req.query;
  const user = userDB.findByChatId(parseInt(chat_id));
  if (!user) return res.status(404).json({ error: 'Topilmadi' });
  const msgs = msgDB.getPrivate(user.id, parseInt(contact_id));
  res.json(msgs);
});

app.post('/api/messages/private', (req, res) => {
  const { chat_id, to_user_id, text } = req.body;
  const user = userDB.findByChatId(parseInt(chat_id));
  if (!user) return res.status(403).json({ error: 'Topilmadi' });
  msgDB.sendPrivate(user.id, parseInt(to_user_id), text.trim());
  res.json({ ok: true });
});

app.get('/api/messages/contacts', (req, res) => {
  const user = userDB.findByChatId(parseInt(req.query.chat_id));
  if (!user) return res.status(404).json({ error: 'Topilmadi' });
  res.json(msgDB.getContacts(user.id));
});

// ─── Serve Mini App ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'miniapp', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log('✅ Server ishlamoqda: ' + PORT);
    console.log('🤖 Bot polling...');
  });
}).catch(err => { console.error('DB xatosi:', err); process.exit(1); });
