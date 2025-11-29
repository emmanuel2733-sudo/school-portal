const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./school.db');
db.all('SELECT id, username, password, role, status, name FROM users', (err, rows) => {
  if (err) console.error('Error:', err);
  console.log('Users:', rows);
  db.close();
});
