const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./school.db');

bcrypt.hash('adminpass', 10, (err, hash) => {
  if (err) {
    console.error('Hash error:', err);
    db.close();
    return;
  }
  db.run(
    `INSERT OR REPLACE INTO users (id, username, password, role, status, name) 
     VALUES (1, 'admin', ?, 'admin', 'approved', 'Administrator')`,
    [hash],
    (err) => {
      if (err) {
        console.error('Insert error:', err);
      } else {
        console.log('Admin user password reset successfully');
      }
      db.close();
    }
  );
});