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
// API uchun no-cache
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'miniapp')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Multer
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
app.get('/api/user/:chat_id', async (req, res) => {
  try {
    const user = await userDB.findByChatId(parseInt(req.params.chat_id));
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/location', async (req, res) => {
  const { chat_id, lat, lng } = req.body;
  if (!chat_id || !lat || !lng) return res.status(400).json({ error: 'Maydonlar kerak' });
  try {
    await userDB.updateLocation(parseInt(chat_id), parseFloat(lat), parseFloat(lng));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mahalla/members', async (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  try {
    const members = await userDB.getByMahalla(mahalla_id);
    res.json(members.map(u => ({ id: u.id, full_name: u.full_name, role: u.role, chat_id: u.chat_id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── POSTS ────────────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  const { mahalla_id, lat, lng } = req.query;
  try {
    let posts;
    if (mahalla_id) {
      // Faqat shu mahalla + 3km atrofdagilarni ham ko'rsin
      posts = await postDB.getAllNearMahalla(mahalla_id);
    } else if (lat && lng) {
      posts = await postDB.getNearby(parseFloat(lat), parseFloat(lng), 5000);
    } else {
      posts = await postDB.getAll();
    }
    res.json(posts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts', upload.single('photo'), async (req, res) => {
  try {
    const { chat_id, type, description, lat, lng } = req.body;
    if (!chat_id || !type || !description || !lat || !lng)
      return res.status(400).json({ error: 'Barcha maydonlar kerak' });

    const user = await userDB.findByChatId(parseInt(chat_id));
    if (!user || !user.registered) return res.status(403).json({ error: 'Ro\'yxatdan o\'tmagan' });

    const mahalla_id = getMahallaId(parseFloat(lat), parseFloat(lng));
    const photo_path = req.file ? `/uploads/${req.file.filename}` : '';

    const result = await postDB.create(user.id, type, '', description, parseFloat(lat), parseFloat(lng), mahalla_id, photo_path);
    const post = { id: result.id, type, description, lat: parseFloat(lat), lng: parseFloat(lng), mahalla_id, photo_path };

    await userDB.addScore(parseInt(chat_id), photo_path ? 8 : 5);
    notifyPost(post, user).catch(console.error);
    res.json({ ok: true, post_id: result.id });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/resolve', async (req, res) => {
  try {
    await postDB.resolve(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/like', async (req, res) => {
  const { chat_id } = req.body;
  try {
    const user = await userDB.findByChatId(parseInt(chat_id));
    if (!user) return res.status(403).json({ error: 'Topilmadi' });
    const liked = await postDB.like(parseInt(req.params.id), user.id);
    if (liked) await userDB.addScore(parseInt(chat_id), 2);
    res.json({ ok: true, liked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS ────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  try {
    const stats = await postDB.getStats(mahalla_id);
    const top = await userDB.getTop(mahalla_id);
    res.json({ ...stats, top_users: top });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── MESSAGES ────────────────────────────────────────────────
app.get('/api/messages/group', async (req, res) => {
  const { mahalla_id } = req.query;
  if (!mahalla_id) return res.status(400).json({ error: 'mahalla_id kerak' });
  try {
    const msgs = await msgDB.getGroup(mahalla_id);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/group', async (req, res) => {
  const { chat_id, text } = req.body;
  if (!chat_id || !text?.trim()) return res.status(400).json({ error: 'Kerakli maydonlar yo\'q' });
  try {
    const user = await userDB.findByChatId(parseInt(chat_id));
    if (!user || !user.registered) return res.status(403).json({ error: 'Ro\'yxatdan o\'tmagan' });
    await msgDB.sendGroup(user.id, user.mahalla_id, text.trim());
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/private', async (req, res) => {
  const { chat_id, contact_id } = req.query;
  try {
    const user = await userDB.findByChatId(parseInt(chat_id));
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    const msgs = await msgDB.getPrivate(user.id, parseInt(contact_id));
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/private', async (req, res) => {
  const { chat_id, to_user_id, text } = req.body;
  try {
    const user = await userDB.findByChatId(parseInt(chat_id));
    if (!user) return res.status(403).json({ error: 'Topilmadi' });
    await msgDB.sendPrivate(user.id, parseInt(to_user_id), text.trim());
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/contacts', async (req, res) => {
  try {
    const user = await userDB.findByChatId(parseInt(req.query.chat_id));
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    const contacts = await msgDB.getContacts(user.id);
    res.json(contacts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Serve Mini App ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'miniapp', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('✅ Server ishlamoqda:', PORT);
    console.log('🤖 Bot polling...');
  });
}).catch(err => {
  console.error('DB xatosi:', err);
  process.exit(1);
});
