const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const app     = express();
const PORT    = process.env.PORT || 3000;

// On Railway use /tmp, locally use home directory
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.PORT;
const DB_DIR  = IS_RAILWAY ? '/tmp' : path.join(os.homedir(), '.j3mpi');
const DB_PATH = path.join(DB_DIR, 'rental.db');

try {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
} catch(e) { console.log('DB dir note:', e.message); }

// ── sql.js wrapper that mimics better-sqlite3 API ─────────────
let DB = null;

function save() {
  fs.writeFileSync(DB_PATH, Buffer.from(DB.export()));
}

function run(sql, params) {
  params = params || [];
  DB.run(sql, params);
  const r = DB.exec('SELECT last_insert_rowid() as id');
  const id = (r && r[0] && r[0].values[0]) ? Number(r[0].values[0][0]) : 0;
  save();
  return id;
}

function all(sql, params) {
  params = params || [];
  try {
    const stmt = DB.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      const raw = stmt.getAsObject();
      const row = {};
      Object.keys(raw).forEach(function(k) {
        row[k] = typeof raw[k] === 'bigint' ? Number(raw[k]) : raw[k];
      });
      rows.push(row);
    }
    stmt.free();
    return rows;
  } catch(e) {
    console.error('SQL error:', e.message, sql);
    return [];
  }
}

function one(sql, params) {
  return all(sql, params || [])[0] || null;
}

// ── Init DB ───────────────────────────────────────────────────
async function initDB() {
  const SQL = await require('sql.js')();
  DB = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  DB.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT 'manager')`);
  DB.run(`CREATE TABLE IF NOT EXISTS properties (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, label TEXT NOT NULL, address TEXT DEFAULT '', base_rent REAL DEFAULT 0)`);
  DB.run(`CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT DEFAULT '', active INTEGER DEFAULT 1)`);
  DB.run(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL, rent_due REAL DEFAULT 0, rent_received REAL DEFAULT 0, late_fee REAL DEFAULT 0, notes TEXT DEFAULT '', paid_date TEXT)`);
  DB.run(`CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL, amount REAL DEFAULT 0, category TEXT NOT NULL, description TEXT DEFAULT '', expense_date TEXT DEFAULT '')`);
  DB.run(`CREATE TABLE IF NOT EXISTS leases (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, property_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, rent_amount REAL DEFAULT 0, notes TEXT DEFAULT '', active INTEGER DEFAULT 1)`);
  DB.run(`CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, property_id INTEGER, tenant_id INTEGER, to_email TEXT, month INTEGER, year INTEGER, amount REAL, sent_at TEXT DEFAULT (datetime('now')))`);
  DB.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`);

  const uc = one('SELECT COUNT(*) as c FROM users');
  if (!uc || Number(uc.c) === 0) {
    run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['admin', bcrypt.hashSync('admin123', 10), 'admin']);
  }
  [['ll_name','J3MPI Rental Property Management'],['ll_email','cpat28@gmail.com'],
   ['ll_phone','(555) 000-0000'],['ll_addr','123 Your St, City, ST 00000']
  ].forEach(function(d) { DB.run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', d); });
  save();
  console.log('DB ready at', DB_PATH);
}

// ── Helpers ───────────────────────────────────────────────────
function loadProps() {
  return all('SELECT * FROM properties ORDER BY name').map(function(p) {
    const t = one('SELECT * FROM tenants WHERE property_id=? AND active=1 LIMIT 1', [p.id]);
    return { id:p.id, name:p.name, label:p.label, address:p.address, base_rent:p.base_rent,
      tenant_id:t?t.id:null, tenant_name:t?t.name:null, tenant_email:t?t.email:null, tenant_phone:t?t.phone:null };
  });
}

function getSettings() {
  const obj = {};
  all('SELECT key,value FROM settings').forEach(function(r) { obj[r.key] = r.value; });
  return obj;
}

// ── Express setup ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'j3mpi-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24*60*60*1000 }
}));
// Serve from public/ if it exists, otherwise root (handles different upload structures)
const publicDir = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
console.log('Serving static files from:', publicDir);
app.use(express.static(publicDir));

app.get('/', function(req, res) {
  res.sendFile(path.join(publicDir, 'index.html'));
});

function auth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ ok: false, msg: 'Not logged in.' });
}

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/login', function(req, res) {
  const u = one('SELECT * FROM users WHERE username=?', [req.body.username]);
  if (!u || !bcrypt.compareSync(req.body.password, u.password_hash))
    return res.json({ ok:false, msg:'Invalid username or password.' });
  req.session.user = { id:Number(u.id), username:u.username, role:u.role };
  res.json({ ok:true, user:req.session.user });
});
app.post('/api/logout', function(req, res) { req.session.destroy(); res.json({ ok:true }); });
app.get('/api/me', function(req, res) { res.json(req.session.user || null); });

// ── Users ─────────────────────────────────────────────────────
app.get('/api/users', auth, function(req, res) {
  res.json(all('SELECT id,username,role FROM users ORDER BY username'));
});
app.post('/api/users', auth, function(req, res) {
  try {
    run('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)',
      [req.body.username, bcrypt.hashSync(req.body.password,10), req.body.role]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, msg:'Username already exists.' }); }
});
app.delete('/api/users/:id', auth, function(req, res) {
  if (req.session.user.id === parseInt(req.params.id))
    return res.json({ ok:false, msg:'Cannot delete yourself.' });
  run('DELETE FROM users WHERE id=?', [parseInt(req.params.id)]);
  res.json({ ok:true });
});

// ── Settings ──────────────────────────────────────────────────
app.get('/api/settings', auth, function(req, res) { res.json(getSettings()); });
app.post('/api/settings', auth, function(req, res) {
  Object.keys(req.body).forEach(function(k) {
    DB.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [k, String(req.body[k])]);
  });
  save();
  res.json({ ok:true });
});

// ── Properties ────────────────────────────────────────────────
app.get('/api/properties', auth, function(req, res) { res.json(loadProps()); });
app.post('/api/properties', auth, function(req, res) {
  try {
    const d = req.body;
    const pid = run('INSERT INTO properties (name,label,address,base_rent) VALUES (?,?,?,?)',
      [d.name, d.label||d.name, d.address||'', parseFloat(d.base_rent)]);
    if (!pid) return res.json({ ok:false, msg:'Failed to create property.' });
    run('INSERT INTO tenants (property_id,name,email,phone,active) VALUES (?,?,?,?,1)',
      [pid, d.tenant_name, d.tenant_email, d.tenant_phone||'']);
    res.json({ ok:true, id:pid });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});
app.put('/api/properties/:id', auth, function(req, res) {
  const d = req.body, id = parseInt(req.params.id);
  run('UPDATE properties SET name=?,label=?,address=?,base_rent=? WHERE id=?',
    [d.name, d.label, d.address||'', parseFloat(d.base_rent), id]);
  if (d.tenant_id)
    run('UPDATE tenants SET name=?,email=?,phone=? WHERE id=?',
      [d.tenant_name, d.tenant_email, d.tenant_phone||'', parseInt(d.tenant_id)]);
  res.json({ ok:true });
});
app.delete('/api/properties/:id', auth, function(req, res) {
  const id = parseInt(req.params.id);
  ['payments','expenses','tenants'].forEach(function(t) {
    DB.run('DELETE FROM '+t+' WHERE property_id=?', [id]);
  });
  run('DELETE FROM properties WHERE id=?', [id]);
  res.json({ ok:true });
});

// ── Payments ──────────────────────────────────────────────────
app.get('/api/payments', auth, function(req, res) {
  res.json(all('SELECT * FROM payments WHERE property_id=? AND year=? ORDER BY month',
    [parseInt(req.query.property_id), parseInt(req.query.year)]));
});
app.post('/api/payments', auth, function(req, res) {
  const d = req.body;
  const pid=parseInt(d.property_id), tid=parseInt(d.tenant_id), mo=parseInt(d.month), yr=parseInt(d.year);
  const due=parseFloat(d.rent_due), recv=parseFloat(d.rent_received), late=parseFloat(d.late_fee);
  const pd = recv > 0 ? new Date().toISOString().slice(0,10) : null;
  const ex = one('SELECT id FROM payments WHERE property_id=? AND month=? AND year=?', [pid,mo,yr]);
  if (ex) run('UPDATE payments SET rent_received=?,late_fee=?,notes=?,paid_date=?,rent_due=? WHERE id=?',
    [recv,late,d.notes||'',pd,due,Number(ex.id)]);
  else run('INSERT INTO payments (property_id,tenant_id,month,year,rent_due,rent_received,late_fee,notes,paid_date) VALUES (?,?,?,?,?,?,?,?,?)',
    [pid,tid,mo,yr,due,recv,late,d.notes||'',pd]);
  res.json({ ok:true });
});

// ── Expenses ──────────────────────────────────────────────────
app.get('/api/expenses', auth, function(req, res) {
  res.json(all('SELECT * FROM expenses WHERE property_id=? AND year=? ORDER BY month,id',
    [parseInt(req.query.property_id), parseInt(req.query.year)]));
});
app.post('/api/expenses', auth, function(req, res) {
  const d = req.body;
  run('INSERT INTO expenses (property_id,month,year,amount,category,description,expense_date) VALUES (?,?,?,?,?,?,?)',
    [parseInt(d.property_id),parseInt(d.month),parseInt(d.year),parseFloat(d.amount),d.category,d.description||'',new Date().toISOString().slice(0,10)]);
  res.json({ ok:true });
});
app.delete('/api/expenses/:id', auth, function(req, res) {
  run('DELETE FROM expenses WHERE id=?', [parseInt(req.params.id)]);
  res.json({ ok:true });
});

// ── Dashboard ─────────────────────────────────────────────────
app.get('/api/dashboard', auth, function(req, res) {
  const yr = parseInt(req.query.year);
  const props = loadProps();
  const results = props.map(function(prop) {
    const pays = all('SELECT * FROM payments WHERE property_id=? AND year=?', [prop.id,yr]);
    const expR = one('SELECT SUM(amount) as t FROM expenses WHERE property_id=? AND year=?', [prop.id,yr]);
    const months = [];
    for (let m=0; m<12; m++) {
      const p = pays.find(function(x){ return Number(x.month)===m+1; });
      const due=p?p.rent_due:prop.base_rent, recv=p?p.rent_received:0, late=p?p.late_fee:0;
      months.push({ month:m+1,due,recv,late,status:(recv>=due&&recv>0)?'paid':(recv>0)?'partial':'unpaid' });
    }
    let tDue=0,tRecv=0,tLate=0;
    months.forEach(function(m){ tDue+=m.due; tRecv+=m.recv; tLate+=m.late; });
    const tExp = expR&&expR.t?expR.t:0;
    return { id:prop.id,label:prop.label,base_rent:prop.base_rent,tenant_name:prop.tenant_name,
      months,tDue,tRecv,tLate,tExp,net:tRecv+tLate-tExp,
      paid:months.filter(function(m){ return m.status==='paid'; }).length };
  });
  const monthly = [];
  for (let m=0; m<12; m++) {
    let c=0,d=0; results.forEach(function(p){ c+=p.months[m].recv; d+=p.months[m].due; });
    monthly.push({ month:m+1,collected:c,due:d });
  }
  res.json({ properties:results,monthly,year:yr });
});

// ── Leases ────────────────────────────────────────────────────
app.get('/api/leases', auth, function(req, res) {
  res.json(all(`SELECT t.id,t.name,t.email,t.phone,t.property_id,p.label as prop_label,p.address,
    l.id as lease_id,l.start_date,l.end_date,l.rent_amount,l.notes
    FROM tenants t JOIN properties p ON p.id=t.property_id
    LEFT JOIN leases l ON l.tenant_id=t.id AND l.active=1
    WHERE t.active=1 ORDER BY l.end_date ASC,p.label ASC`));
});
app.post('/api/leases', auth, function(req, res) {
  const d = req.body;
  DB.run('UPDATE leases SET active=0 WHERE tenant_id=?', [parseInt(d.tenant_id)]);
  run('INSERT INTO leases (tenant_id,property_id,start_date,end_date,rent_amount,notes,active) VALUES (?,?,?,?,?,?,1)',
    [parseInt(d.tenant_id),parseInt(d.property_id),d.start_date,d.end_date,parseFloat(d.rent_amount)||0,d.notes||'']);
  res.json({ ok:true });
});
app.get('/api/leases/alerts', auth, function(req, res) {
  const today = new Date().toISOString().slice(0,10);
  const in60  = new Date(Date.now()+60*24*60*60*1000).toISOString().slice(0,10);
  res.json(all(`SELECT t.name as tenant_name,p.label as prop_label,l.end_date,l.start_date
    FROM leases l JOIN tenants t ON t.id=l.tenant_id JOIN properties p ON p.id=l.property_id
    WHERE l.active=1 AND l.end_date<=? AND l.end_date>=? ORDER BY l.end_date ASC`, [in60,today]));
});

// ── Tax Report ────────────────────────────────────────────────
app.get('/api/taxreport', auth, function(req, res) {
  const yr = parseInt(req.query.year);
  const props = loadProps();
  const report = props.map(function(prop) {
    const pays = all('SELECT * FROM payments WHERE property_id=? AND year=?', [prop.id,yr]);
    let tRecv=0,tLate=0; pays.forEach(function(p){ tRecv+=p.rent_received; tLate+=p.late_fee; });
    const exps = all('SELECT category,SUM(amount) as total FROM expenses WHERE property_id=? AND year=? GROUP BY category', [prop.id,yr]);
    const tExp = exps.reduce(function(s,e){ return s+e.total; },0);
    return { id:prop.id,label:prop.label,address:prop.address,tenant_name:prop.tenant_name,
      totalRecv:tRecv,totalLate:tLate,grossIncome:tRecv+tLate,expenses:exps,totalExp:tExp,netIncome:(tRecv+tLate)-tExp };
  });
  const grandIncome=report.reduce(function(s,r){ return s+r.grossIncome; },0);
  const grandExp=report.reduce(function(s,r){ return s+r.totalExp; },0);
  const allCats=all('SELECT category,SUM(amount) as total FROM expenses WHERE year=? GROUP BY category ORDER BY total DESC',[yr]);
  res.json({ year:yr,properties:report,grandIncome,grandExp,grandNet:grandIncome-grandExp,allCategories:allCats });
});

// ── Email Receipt ─────────────────────────────────────────────
app.post('/api/email-receipt', auth, function(req, res) {
  const d = req.body;
  const cfg  = getSettings();
  const prop = one('SELECT * FROM properties WHERE id=?', [parseInt(d.property_id)]);
  const ten  = one('SELECT * FROM tenants WHERE id=?',   [parseInt(d.tenant_id)]);
  if (!prop||!ten) return res.json({ ok:false, msg:'Property or tenant not found.' });
  const pay  = one('SELECT * FROM payments WHERE property_id=? AND month=? AND year=?',
    [parseInt(d.property_id),parseInt(d.month),parseInt(d.year)]);
  const MN   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const due=pay?pay.rent_due:prop.base_rent, recv=pay?pay.rent_received:0, late=pay?pay.late_fee:0, total=recv+late;
  const isPaid=recv>=due&&due>0, isPart=recv>0&&recv<due;
  const rNo  = prop.name.replace(/[^A-Z0-9]/gi,'')+'-'+MN[d.month-1].slice(0,3).toUpperCase()+'-'+d.year;
  const dated = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const status = isPaid?'PAID IN FULL':isPart?'PARTIAL - Balance: $'+(due-recv).toFixed(2):'BALANCE DUE: $'+due.toFixed(2);
  const body = [
    'Hi '+ten.name+',','','Your rent receipt for '+MN[d.month-1]+' '+d.year+':','',
    '================================================','         J3MPI PROPERTY MANAGEMENT',
    '           OFFICIAL RENT RECEIPT','================================================',
    '  Property  : '+prop.label,'  Address   : '+(prop.address||'N/A'),
    '  Tenant    : '+ten.name,'  Period    : '+MN[d.month-1]+' '+d.year,
    '  Receipt # : '+rNo,'  Date      : '+dated,'',
    '  Rent Due        : $'+due.toFixed(2),'  Rent Received   : $'+recv.toFixed(2),
    late>0?'  Late Fee        : $'+late.toFixed(2):null,
    '  .............................................','  TOTAL RECEIVED  : $'+total.toFixed(2),'',
    '  >> STATUS: '+status,'',
    '================================================','Thank you for your payment!','',
    cfg.ll_name||'',cfg.ll_phone||'',cfg.ll_email||'',
    '================================================',
  ].filter(function(l){ return l!==null; }).join('\n');
  const subj = 'Rent Receipt - '+prop.label+' - '+MN[d.month-1]+' '+d.year;
  const gmailUrl = 'https://mail.google.com/mail/?view=cm&to='+encodeURIComponent(ten.email)+'&su='+encodeURIComponent(subj)+'&body='+encodeURIComponent(body);
  run('INSERT INTO email_log (type,property_id,tenant_id,to_email,month,year,amount) VALUES (?,?,?,?,?,?,?)',
    ['receipt',parseInt(d.property_id),parseInt(d.tenant_id),ten.email,parseInt(d.month),parseInt(d.year),total]);
  res.json({ ok:true, gmailUrl, msg:'Receipt ready for '+ten.email });
});

app.get('/api/email-log', auth, function(req, res) {
  res.json(all('SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 200').map(function(el) {
    const p = one('SELECT label FROM properties WHERE id=?', [Number(el.property_id)]);
    const t = one('SELECT name FROM tenants WHERE id=?',    [Number(el.tenant_id)]);
    el.prop_label = p?p.label:'—'; el.ten_name = t?t.name:'—'; return el;
  }));
});

// ── Start ─────────────────────────────────────────────────────
initDB().then(function() {
  app.listen(PORT, '0.0.0.0', function() {
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    Object.values(interfaces).forEach(function(iface) {
      iface.forEach(function(addr) { if (addr.family==='IPv4'&&!addr.internal) localIP=addr.address; });
    });
    console.log('\n========================================');
    console.log('  J3MPI Rental Manager - Web Version');
    console.log('========================================');
    console.log('  Local  : http://localhost:'+PORT);
    console.log('  Network: http://'+localIP+':'+PORT);
    console.log('========================================\n');
  });
}).catch(function(e) {
  console.error('Failed to start:', e);
  process.exit(1);
});
