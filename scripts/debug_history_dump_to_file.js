const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const db = new sqlite3.Database('school.db');
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

(async () => {
  try {
    const outputPath = path.join(__dirname, '..', 'debug_history_output.json');

    const year = await dbGet('SELECT id, year FROM academic_years ORDER BY id LIMIT 1');
    if (!year) return fs.writeFileSync(outputPath, JSON.stringify({ error: 'No academic_years found' }, null, 2));
    const cls = await dbGet('SELECT id, name FROM classes ORDER BY id LIMIT 1');
    if (!cls) return fs.writeFileSync(outputPath, JSON.stringify({ error: 'No classes found' }, null, 2));

    const yearId = year.id;
    const classId = cls.id;

    const terms = await dbAll('SELECT id, name as term_name FROM terms WHERE year_id = ? ORDER BY id', [yearId]);
    const termIds = terms.map(t => t.id);

    const students = await dbAll(`
      SELECT DISTINCT u.id, u.name AS student_name
      FROM users u
      JOIN student_enrollments se ON se.student_id = u.id
      JOIN courses co ON se.course_id = co.id
      WHERE co.class_id = ? AND se.term_id IN (${termIds.map(() => '?').join(',')})
      ORDER BY u.name
    `, [classId, ...termIds]);

    const courses = await dbAll(`
      SELECT DISTINCT c.id, c.name AS course_name
      FROM courses c
      JOIN student_enrollments se ON se.course_id = c.id
      WHERE se.term_id IN (${termIds.map(() => '?').join(',')}) AND c.class_id = ?
    `, [...termIds, classId]);

    const grades = await dbAll(`
      SELECT student_id, term_id, course_id, 
             CASE 
               WHEN grade IS NOT NULL AND grade != '' THEN grade
               WHEN total >= 70 THEN 'A'
               WHEN total >= 60 THEN 'B'
               WHEN total >= 50 THEN 'C'
               WHEN total >= 40 THEN 'D'
               ELSE 'F'
             END AS grade, total
      FROM grades 
      WHERE student_id IN (${students.map(s => s.id).join(',') || 'NULL'})
        AND term_id IN (${termIds.join(',') || 'NULL'})
    `);

    const out = { year: {id: yearId, year: year.year}, class: {id: classId, name: cls.name}, terms, courses, students, grades };
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
    console.log('Wrote debug output to', outputPath);
    db.close();
  } catch (err) {
    fs.writeFileSync(path.join(__dirname, '..', 'debug_history_output.json'), JSON.stringify({ error: err.message }, null, 2));
    console.error('ERROR', err);
    db.close();
    process.exit(1);
  }
})();
