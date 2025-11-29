// fix-enrollment-id.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'school.db'));

console.log('Adding missing enrollment_id column to grades table...');

db.serialize(() => {
  db.run(`
    ALTER TABLE grades ADD COLUMN enrollment_id INTEGER REFERENCES student_enrollments(id)
  `, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.error('ERROR adding column:', err.message);
    } else {
      console.log('enrollment_id column added (or already exists)');
    }
  });

  // Optional: Link existing grades to enrollments (safe fallback)
  db.run(`
    UPDATE grades 
    SET enrollment_id = (
      SELECT se.id 
      FROM student_enrollments se 
      WHERE se.student_id = grades.student_id 
        AND se.course_id = grades.course_id 
        AND se.term_id = grades.term_id 
      LIMIT 1
    )
    WHERE enrollment_id IS NULL
      AND student_id IN (SELECT id FROM users WHERE role = 'student')
  `, () => {
    console.log('Linked existing grades to enrollments');
  });
});

setTimeout(() => {
  db.close(() => {
    console.log('\nFIX COMPLETE!');
    console.log('Restart your app and try student login again.');
  });
}, 1000);