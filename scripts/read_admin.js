const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./school.db', (err)=>{ if(err){ console.error('DB open error', err); process.exit(2);}});

db.get("SELECT id, username, password, role, status, name FROM users WHERE username = ?", ['admin'], (err, row) => {
  if (err) {
    console.error('QUERY ERROR', err);
    process.exit(2);
  }
  console.log(JSON.stringify(row, null, 2));
  db.close();
});
