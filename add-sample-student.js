const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'school.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
  console.log('Connected to database:', dbPath);
});

async function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) {
        console.error(`Error executing query: ${query}`, err);
        reject(err);
      } else {
        console.log(`Query executed: ${query}`);
        resolve(this);
      }
    });
  });
}

async function insertOrIgnore(table, data) {
  const keys = Object.keys(data);
  const placeholders = keys.map(() => '?').join(', ');
  const query = `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  return runQuery(query, Object.values(data));
}

async function insertSampleData() {
  try {
    await insertOrIgnore('academic_years', { year: 2025, current: 1 });
    const academicYear = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM academic_years WHERE year = ?', [2025], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    await insertOrIgnore('terms', { name: 'First Term', year_id: academicYear.id, term_number: 1 });
    const firstTerm = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM terms WHERE name = ?', ['First Term'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    await insertOrIgnore('classes', { name: 'JS1' });
    const js1Class = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM classes WHERE name = ?', ['JS1'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    await insertOrIgnore('courses', { name: 'Mathematics', class_id: js1Class.id });
    await insertOrIgnore('courses', { name: 'English', class_id: js1Class.id });
    const mathCourse = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM courses WHERE name = ?', ['Mathematics'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    const englishCourse = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM courses WHERE name = ?', ['English'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const studentPassword = await bcrypt.hash('studentpass', 10);
    await insertOrIgnore('users', {
      username: 'student2',
      password: studentPassword,
      role: 'student',
      status: 'approved',
      name: 'Student Two',
      photo: null
    });
    const student = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ?', ['student2'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    const teacherPassword = await bcrypt.hash('teacherpass', 10);
    await insertOrIgnore('users', {
      username: 'teacher1',
      password: teacherPassword,
      role: 'teacher',
      status: 'approved',
      name: 'Teacher One',
      photo: null
    });
    const teacher = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ?', ['teacher1'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    await insertOrIgnore('teacher_assignments', { teacher_id: teacher.id, course_id: mathCourse.id });
    await insertOrIgnore('teacher_assignments', { teacher_id: teacher.id, course_id: englishCourse.id });

    await insertOrIgnore('student_enrollments', {
      student_id: student.id,
      course_id: mathCourse.id,
      term_id: firstTerm.id
    });
    await insertOrIgnore('student_enrollments', {
      student_id: student.id,
      course_id: englishCourse.id,
      term_id: firstTerm.id
    });

    await insertOrIgnore('grades', {
      student_id: student.id,
      course_id: mathCourse.id,
      term_id: firstTerm.id,
      score: 85,
      grade: 'A',
      comments: 'Excellent work in algebra'
    });
    await insertOrIgnore('grades', {
      student_id: student.id,
      course_id: englishCourse.id,
      term_id: firstTerm.id,
      score: 78,
      grade: 'B',
      comments: 'Good effort in essay writing'
    });

    console.log('Sample data inserted successfully');
  } catch (err) {
    console.error('Error inserting sample data:', err);
  } finally {
    db.close();
  }
}

insertSampleData();