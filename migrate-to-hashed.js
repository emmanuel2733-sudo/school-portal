const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'school.db'), err => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  }
  console.log('Connected to database');
});

db.all('SELECT id, username, password FROM users', async (err, users) => {
  if (err) {
    console.error('Error fetching users:', err);
    db.close();
    return;
  }
  for (const user of users) {
    // Skip if already hashed (bcrypt hashes start with $2b$)
    if (user.password.startsWith('$2b$')) {
      console.log(`Password for ${user.username} already hashed`);
      continue;
    }
    try {
      const hashedPassword = await bcrypt.hash(user.password, 10);
      db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id], err => {
        if (err) {
          console.error(`Error updating user ${user.username}:`, err);
        } else {
          console.log(`Hashed password for ${user.username}`);
        }
      });
    } catch (err) {
      console.error(`Error hashing password for ${user.username}:`, err);
    }
  }
  setTimeout(() => {
    db.close();
    console.log('Database closed. Migration complete.');
  }, 2000);
});