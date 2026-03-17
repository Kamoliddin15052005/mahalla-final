const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'mahalla.db');
const db = new sqlite3.Database(DB_PATH);

const run = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { err ? rej(err) : res(this); })
);
const get = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => err ? rej(err) : res(row))
);
const all = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows || []))
);

async function initDB() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER UNIQUE NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    role TEXT DEFAULT 'aholi',
    lat REAL DEFAULT 0, lng REAL DEFAULT 0,
    mahalla_id TEXT DEFAULT '',
    score INTEGER DEFAULT 0,
    registered INTEGER DEFAULT 0,
    reg_step TEXT DEFAULT 'name',
    temp_name TEXT DEFAULT '',
    temp_lat REAL DEFAULT 0, temp_lng REAL DEFAULT 0,
    temp_role TEXT DEFAULT 'aholi',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT DEFAULT '',
    description TEXT NOT NULL,
    lat REAL NOT NULL, lng REAL NOT NULL,
    mahalla_id TEXT DEFAULT '',
    photo_path TEXT DEFAULT '',
    resolved INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS post_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(post_id, user_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER,
    mahalla_id TEXT DEFAULT '',
    text TEXT NOT NULL,
    is_group INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('DB ready');
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function getMahallaId(lat, lng) {
  const s = 0.005;
  return `${(Math.round(lat/s)*s).toFixed(3)}_${(Math.round(lng/s)*s).toFixed(3)}`;
}

const userDB = {
  findByChatId: (chat_id) => get('SELECT * FROM users WHERE chat_id=?',[chat_id]),
  upsertTemp: async (chat_id, fields) => {
    const ex = await get('SELECT id FROM users WHERE chat_id=?',[chat_id]);
    if (!ex) await run('INSERT INTO users (chat_id,full_name,phone) VALUES (?,?,?)',[chat_id,'','']);
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map(k=>`${k}=?`).join(',');
      await run(`UPDATE users SET ${sets} WHERE chat_id=?`,[...Object.values(fields),chat_id]);
    }
  },
  finishRegistration: async (chat_id) => {
    const u = await get('SELECT * FROM users WHERE chat_id=?',[chat_id]);
    if (!u) return null;
    const mid = getMahallaId(u.temp_lat||0, u.temp_lng||0);
    await run(`UPDATE users SET full_name=?,phone=?,role=?,lat=?,lng=?,mahalla_id=?,registered=1,reg_step='done' WHERE chat_id=?`,
      [u.temp_name,u.phone,u.temp_role||'aholi',u.temp_lat,u.temp_lng,mid,chat_id]);
    return get('SELECT * FROM users WHERE chat_id=?',[chat_id]);
  },
  updateLocation: async (chat_id, lat, lng) => {
    await run('UPDATE users SET lat=?,lng=?,mahalla_id=? WHERE chat_id=?',[lat,lng,getMahallaId(lat,lng),chat_id]);
  },
  addScore: (chat_id, pts=5) => run('UPDATE users SET score=score+? WHERE chat_id=?',[pts,chat_id]),
  getByMahalla: (mid) => all('SELECT * FROM users WHERE mahalla_id=? AND registered=1',[mid]),
  getTop: (mid) => all('SELECT full_name,role,score FROM users WHERE mahalla_id=? ORDER BY score DESC LIMIT 10',[mid]),
  getNearby: async (lat, lng, r) => {
    const us = await all('SELECT * FROM users WHERE registered=1');
    return us.filter(u=>u.lat&&u.lng&&getDistance(lat,lng,u.lat,u.lng)<=r);
  }
};

const postDB = {
  create: (uid,type,title,desc,lat,lng,mid,photo) =>
    run('INSERT INTO posts (user_id,type,title,description,lat,lng,mahalla_id,photo_path) VALUES (?,?,?,?,?,?,?,?)',
      [uid,type,title||'',desc,lat,lng,mid,photo||'']),
  getByMahalla: (mid) => all(
    'SELECT p.*,u.full_name,u.role FROM posts p JOIN users u ON p.user_id=u.id WHERE p.mahalla_id=? ORDER BY p.created_at DESC LIMIT 50',[mid]),
  getNearby: async (lat,lng,r) => {
    const ps = await all('SELECT p.*,u.full_name,u.role FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC');
    return ps.filter(p=>getDistance(lat,lng,p.lat,p.lng)<=r);
  },
  resolve: (id) => run('UPDATE posts SET resolved=1 WHERE id=?',[id]),
  like: async (pid,uid) => {
    try { await run('INSERT INTO post_likes (post_id,user_id) VALUES (?,?)',[pid,uid]);
      await run('UPDATE posts SET likes=likes+1 WHERE id=?',[pid]); return true;
    } catch { return false; }
  },
  getStats: async (mid) => {
    const total = (await get('SELECT COUNT(*) as c FROM posts WHERE mahalla_id=?',[mid]))?.c||0;
    const muammo = (await get("SELECT COUNT(*) as c FROM posts WHERE mahalla_id=? AND type='muammo'",[mid]))?.c||0;
    const resolved = (await get('SELECT COUNT(*) as c FROM posts WHERE mahalla_id=? AND resolved=1',[mid]))?.c||0;
    const toy = (await get("SELECT COUNT(*) as c FROM posts WHERE mahalla_id=? AND type='toy'",[mid]))?.c||0;
    return {total,muammo,resolved,toy,pending:muammo-resolved};
  }
};

const msgDB = {
  sendGroup: (fuid,mid,text) => run('INSERT INTO messages (from_user_id,mahalla_id,text,is_group) VALUES (?,?,?,1)',[fuid,mid,text]),
  sendPrivate: (fuid,tuid,text) => run('INSERT INTO messages (from_user_id,to_user_id,text,is_group,mahalla_id) VALUES (?,?,?,0,"")',[fuid,tuid,text]),
  getGroup: async (mid,lim=50) => (await all(
    'SELECT m.*,u.full_name,u.role FROM messages m JOIN users u ON m.from_user_id=u.id WHERE m.mahalla_id=? AND m.is_group=1 ORDER BY m.created_at DESC LIMIT ?',[mid,lim])).reverse(),
  getPrivate: (u1,u2) => all(
    'SELECT m.*,u.full_name FROM messages m JOIN users u ON m.from_user_id=u.id WHERE is_group=0 AND ((from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)) ORDER BY m.created_at ASC LIMIT 50',[u1,u2,u2,u1]),
  getContacts: (uid) => all(
    `SELECT DISTINCT CASE WHEN from_user_id=? THEN to_user_id ELSE from_user_id END as contact_id,
     u.full_name,u.role,MAX(m.created_at) as last_time
     FROM messages m JOIN users u ON u.id=CASE WHEN from_user_id=? THEN to_user_id ELSE from_user_id END
     WHERE is_group=0 AND (from_user_id=? OR to_user_id=?) GROUP BY contact_id ORDER BY last_time DESC`,[uid,uid,uid,uid])
};

module.exports = { userDB, postDB, msgDB, getDistance, getMahallaId, initDB };
