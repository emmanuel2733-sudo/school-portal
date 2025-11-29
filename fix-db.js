const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./school.db');

db.serialize(() => {
  db.run(`ALTER TABLE teacher_assignments ADD COLUMN term_id INTEGER`, (err) => {
    if (err) {
      console.log("Column might already exist or error:", err.message);
    } else {
      console.log("term_id column added successfully");
    }
    db.close();
  });
});