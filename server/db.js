require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const q = (sql, p=[]) => pool.query(sql, p).then(r=>r.rows);
const q1 = (sql, p=[]) => pool.query(sql, p).then(r=>r.rows[0]||null);

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, chat_id BIGINT UNIQUE NOT NULL,
    full_name TEXT DEFAULT '', phone TEXT DEFAULT '', role TEXT DEFAULT 'aholi',
    lat REAL DEFAULT 0, lng REAL DEFAULT 0, mahalla_id TEXT DEFAULT '',
    score INTEGER DEFAULT 0, registered INTEGER DEFAULT 0, reg_step TEXT DEFAULT 'name',
    temp_name TEXT DEFAULT '', temp_lat REAL DEFAULT 0, temp_lng REAL DEFAULT 0,
    temp_role TEXT DEFAULT 'aholi', created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
    title TEXT DEFAULT '', description TEXT NOT NULL,
    lat REAL NOT NULL, lng REAL NOT NULL, mahalla_id TEXT DEFAULT '',
    photo_path TEXT DEFAULT '', resolved INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS post_likes (
    id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    UNIQUE(post_id, user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, from_user_id INTEGER NOT NULL, to_user_id INTEGER,
    mahalla_id TEXT DEFAULT '', text TEXT NOT NULL, is_group INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  console.log('DB ready (PostgreSQL)');
}

function getDistance(lat1,lon1,lat2,lon2){
  const R=6371000,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function getMahallaId(lat,lng){
  const s=0.005;
  return `${(Math.round(lat/s)*s).toFixed(3)}_${(Math.round(lng/s)*s).toFixed(3)}`;
}

const userDB = {
  findByChatId: (cid) => q1('SELECT * FROM users WHERE chat_id=$1',[cid]),
  upsertTemp: async (cid, fields) => {
    const ex = await q1('SELECT id FROM users WHERE chat_id=$1',[cid]);
    if(!ex) await pool.query('INSERT INTO users (chat_id,full_name,phone) VALUES ($1,$2,$3)',[cid,'','']);
    if(Object.keys(fields).length){
      const keys=Object.keys(fields),vals=Object.values(fields);
      const sets=keys.map((k,i)=>`${k}=$${i+1}`).join(',');
      await pool.query(`UPDATE users SET ${sets} WHERE chat_id=$${keys.length+1}`,[...vals,cid]);
    }
  },
  finishRegistration: async (cid) => {
    const u=await q1('SELECT * FROM users WHERE chat_id=$1',[cid]);
    if(!u) return null;
    const mid=getMahallaId(u.temp_lat||0,u.temp_lng||0);
    await pool.query(
      `UPDATE users SET full_name=$1,phone=$2,role=$3,lat=$4,lng=$5,mahalla_id=$6,registered=1,reg_step='done' WHERE chat_id=$7`,
      [u.temp_name,u.phone,u.temp_role||'aholi',u.temp_lat,u.temp_lng,mid,cid]
    );
    return q1('SELECT * FROM users WHERE chat_id=$1',[cid]);
  },
  updateLocation: async (cid,lat,lng) => {
    await pool.query('UPDATE users SET lat=$1,lng=$2,mahalla_id=$3 WHERE chat_id=$4',[lat,lng,getMahallaId(lat,lng),cid]);
  },
  addScore: (cid,pts=5) => pool.query('UPDATE users SET score=score+$1 WHERE chat_id=$2',[pts,cid]),
  getByMahalla: (mid) => q('SELECT * FROM users WHERE mahalla_id=$1 AND registered=1',[mid]),
  getTop: (mid) => q('SELECT full_name,role,score FROM users WHERE mahalla_id=$1 ORDER BY score DESC LIMIT 10',[mid]),
  getNearby: async (lat,lng,r) => {
    const us=await q('SELECT * FROM users WHERE registered=1');
    return us.filter(u=>u.lat&&u.lng&&getDistance(lat,lng,u.lat,u.lng)<=r);
  }
};

const postDB = {
  create: async (uid,type,title,desc,lat,lng,mid,photo) => {
    const r=await pool.query(
      'INSERT INTO posts (user_id,type,title,description,lat,lng,mahalla_id,photo_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [uid,type,title||'',desc,lat,lng,mid,photo||'']
    );
    return r.rows[0];
  },
  getByMahalla: (mid) => q(
    'SELECT p.*,u.full_name,u.role FROM posts p JOIN users u ON p.user_id=u.id WHERE p.mahalla_id=$1 ORDER BY p.created_at DESC LIMIT 50',[mid]),
  getNearby: async (lat,lng,r) => {
    const ps=await q('SELECT p.*,u.full_name,u.role FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC');
    return ps.filter(p=>getDistance(lat,lng,p.lat,p.lng)<=r);
  },
  resolve: (id) => pool.query('UPDATE posts SET resolved=1 WHERE id=$1',[id]),
  like: async (pid,uid) => {
    try{
      await pool.query('INSERT INTO post_likes (post_id,user_id) VALUES ($1,$2)',[pid,uid]);
      await pool.query('UPDATE posts SET likes=likes+1 WHERE id=$1',[pid]);
      return true;
    }catch{return false;}
  },
  getStats: async (mid) => {
    const [t,m,res,toy]=await Promise.all([
      q1('SELECT COUNT(*) c FROM posts WHERE mahalla_id=$1',[mid]),
      q1("SELECT COUNT(*) c FROM posts WHERE mahalla_id=$1 AND type='muammo'",[mid]),
      q1('SELECT COUNT(*) c FROM posts WHERE mahalla_id=$1 AND resolved=1',[mid]),
      q1("SELECT COUNT(*) c FROM posts WHERE mahalla_id=$1 AND type='toy'",[mid])
    ]);
    const total=parseInt(t?.c)||0,muammo=parseInt(m?.c)||0,resolved=parseInt(res?.c)||0;
    return{total,muammo,resolved,toy:parseInt(toy?.c)||0,pending:muammo-resolved};
  }
};

const msgDB = {
  sendGroup: (fuid,mid,text) => pool.query('INSERT INTO messages (from_user_id,mahalla_id,text,is_group) VALUES ($1,$2,$3,1)',[fuid,mid,text]),
  sendPrivate: (fuid,tuid,text) => pool.query("INSERT INTO messages (from_user_id,to_user_id,text,is_group,mahalla_id) VALUES ($1,$2,$3,0,'')",[fuid,tuid,text]),
  getGroup: async (mid,lim=50) => (await q(
    'SELECT m.*,u.full_name,u.role FROM messages m JOIN users u ON m.from_user_id=u.id WHERE m.mahalla_id=$1 AND m.is_group=1 ORDER BY m.created_at DESC LIMIT $2',[mid,lim])).reverse(),
  getPrivate: (u1,u2) => q(
    'SELECT m.*,u.full_name FROM messages m JOIN users u ON m.from_user_id=u.id WHERE is_group=0 AND ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) ORDER BY m.created_at ASC LIMIT 50',[u1,u2]),
  getContacts: (uid) => q(
    `SELECT DISTINCT CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END as contact_id,
     u.full_name,u.role,MAX(m.created_at) as last_time
     FROM messages m JOIN users u ON u.id=CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END
     WHERE is_group=0 AND (from_user_id=$1 OR to_user_id=$1) GROUP BY contact_id,u.full_name,u.role ORDER BY last_time DESC`,[uid])
};

module.exports = { userDB, postDB, msgDB, getDistance, getMahallaId, initDB };
