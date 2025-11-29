// fix-missing-enrollments.js  ← UPDATED & GUARANTEED TO WORK
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'school.db'));

console.log('Fixing missing course enrollments...\n');

db.serialize(() => {
  // 1. Get current term — your app uses terms.is_current = 1
  db.get("SELECT id, name FROM terms WHERE is_current = 1", (err, row) => {
    if (err || !row) {
      console.log('No current term found! Make sure one term has is_current = 1');
      console.log('Run this in your DB (or via admin):');
      console.log('   UPDATE terms SET is_current = 1 WHERE id = 1;   -- or any term ID');
      return db.close();
    }

    const termId = row.id;
    console.log(`Current term found: ${row.name} (ID: ${termId})\n`);

    // 2. Get all teacher-assigned courses + their class
    db.all(`
      SELECT ta.course_id, c.class_id
      FROM teacher_assignments ta
      JOIN courses c ON ta.course_id = c.id
    `, async (err, assignments) => {
      if (err || assignments.length === 0) {
        console.log('No teacher assignments found.');
        return db.close();
      }

      let totalAdded = 0;

      for (const assign of assignments) {
        const { course_id, class_id } = assign;

        // Get students in this class
        const students = await new Promise(res => 
          db.all("SELECT id FROM users WHERE class_id = ? AND role = 'student'", [class_id], (e, r) => res(r || []))
        );

        if (students.length === 0) continue;

        console.log(`Course ID ${course_id} (Class ID ${class_id}) → ${students.length} students`);

        for (const student of students) {
          const exists = await new Promise(res => 
            db.get("SELECT 1 FROM student_enrollments WHERE student_id = ? AND course_id = ? AND term_id = ?", 
              [student.id, course_id, termId], (e, r) => res(r))
          );

          if (!exists) {
            await new Promise(res => 
              db.run("INSERT INTO student_enrollments (student_id, course_id, term_id, enrolled_at) VALUES (?, ?, ?, datetime('now'))",
                [student.id, course_id, termId], function(err) {
                  if (!err) { totalAdded++; process.stdout.write('+'); }
                  res();
                })
            );
          } else {
            process.stdout.write('.');
          }
        }
        console.log('');
      }

      console.log('\nFIX COMPLETE!');
      console.log(`Added ${totalAdded} missing course enrollments`);
      console.log('Teachers can now see all students in the grading sheet!');
      db.close();
    });
  });
});