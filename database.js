
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'school.db');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('ERROR opening database:', err.message);
  } else {
    console.log('Database opened successfully');

    // FINAL 100% WORKING — SAFE PARENT COLUMNS ADDITION
    const addParentColumnsSafely = () => {
      db.all("PRAGMA table_info(users)", (err, rows) => {
        if (err) return console.error("PRAGMA failed:", err);

        const columns = rows.map(r => r.name);

        const toAdd = [
          { name: "parent_name", def: "TEXT" },
          { name: "parent_phone", def: "TEXT" },
          { name: "parent_address", def: "TEXT" },
          { name: "parent_relationship", def: "TEXT CHECK(parent_relationship IN ('Father','Mother','Guardian','Other'))" }
        ];

        toAdd.forEach(col => {
          if (!columns.includes(col.name)) {
            db.run(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`, err => {
              if (err) console.error("Failed to add column:", col.name, err);
              else console.log("Added column:", col.name);
            });
          }
        });
      });
    };

    addParentColumnsSafely();

        // === CREATE GRADES TABLE (SAFE) ===
    db.run(`
      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        score INTEGER,
        grade TEXT,
        term TEXT,
        year TEXT,
        FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) {
        console.error('Failed to create grades table:', err);
      } else {
        console.log('grades table ready');
      }
    });
  }
});

// PROMISIFIED QUERY — FIXED FOR YOUR DB (100% WORKING)
// ──────────────────────────────────────────────────────────────
//  FINAL, BULLETPROOF QUERY & GET – COPY-PASTE THIS EXACTLY
// ──────────────────────────────────────────────────────────────
// REPLACE THESE TWO FUNCTIONS ONLY
// function query(sql, params = []) {
//   return new Promise((resolve, reject) => {
//     db.all(sql, params, (err, rows) => {
//       if (err) return reject(err);
//       const clean = rows.map(row => {
//         const o = {};
//         for (const key in row) {
//           o[key.split('.').pop()] = row[key];
//         }
//         return o;
//       });
//       resolve(clean);
//     });
//   });
// }

// function get(sql, params = []) {
//   return new Promise((resolve, reject) => {
//     db.get(sql, params, (err, row) => {
//       if (err) return reject(err);
//       if (!row) return resolve(null);
//       const o = {};
//       for (const key in row) {
//         o[key.split('.').pop()] = row[key];
//       }
//       resolve(o);
//     });
//   });
// }
////////////////////////////////////////////////////////////////////////////
// FINAL WORKING VERSION — DO NOT TOUCH AGAIN
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows); // ← RETURN RAW ROWS, NO MODIFICATION
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null); // ← RETURN RAW ROW
    });
  });
}
//////////////////////////////////////////////////////////////////////////////

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}


// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Create tables using db.run()
db.serialize(() => {
  console.log('Creating tables...');

  // Academic Years
db.run(`
  CREATE TABLE IF NOT EXISTS academic_years (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year TEXT UNIQUE NOT NULL,
    current INTEGER DEFAULT 0,
    is_completed INTEGER DEFAULT 0,
    current_term_id INTEGER REFERENCES terms(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error('academic_years table error:', err);
  else console.log('academic_years table ready');
});

  // Add current_term_id column (idempotent)
db.run(`
  ALTER TABLE academic_years ADD COLUMN current_term_id INTEGER REFERENCES terms(id)
`, err => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('Failed to add current_term_id:', err);
  } else {
    console.log('current_term_id column ready');
  }
});

  // Terms
  db.run(`
    CREATE TABLE IF NOT EXISTS terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      term_number INTEGER NOT NULL,
      FOREIGN KEY (year_id) REFERENCES academic_years(id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) console.error('terms table error:', err);
    else console.log('terms table ready');
  });

  // Classes (global: JS1, JS2, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `, (err) => {
    if (err) console.error('classes table error:', err);
    else console.log('classes table ready');
  });

  // Courses (per class)
  db.run(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      UNIQUE(class_id, name)
    )
  `, (err) => {
    if (err) console.error('courses table error:', err);
    else console.log('courses table ready');
  });

   // === USERS TABLE + ADMIN INSERT (GUARANTEED) ===
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    name TEXT,
    role TEXT CHECK(role IN ('student', 'teacher', 'admin')),
    status TEXT CHECK(status IN ('pending', 'active', 'rejected', 'approved', 'disabled')) DEFAULT 'pending',
    sex TEXT CHECK(sex IN ('Male', 'Female')),
    dob DATE,
    address TEXT,
    photo TEXT
  )`, (err) => {
    if (err) {
      console.error('Error creating users table:', err);
      return;
    }
    console.log('users table ready');

    
    // === NOW INSERT ADMIN — 100% SAFE ===
    bcrypt.hash('adminpass', 10, (err, hash) => {
      if (err) {
        console.error('Error hashing admin password:', err);
        return;
      }

      db.run(
  `INSERT OR IGNORE INTO users (username, password, role, status, name, sex, dob, address, photo)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['admin', hash, 'admin', 'approved', 'Administrator', 'Male', '1980-01-01', 'Admin Office', 'default-photo.jpg'],
  (err) => {
    if (err) {
      console.error('Error inserting admin:', err);
    } else {
      console.log('Admin user ready (inserted or already exists)');
    }
  }
);
    });
  });

// photo column for users
db.run(`
  ALTER TABLE users ADD COLUMN photo TEXT DEFAULT 'default-photo.jpg'
`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('Error adding photo column:', err);
  } else {
    console.log('Photo column ready');
  }
});

  // Teacher Assignments
  db.run(`
    CREATE TABLE IF NOT EXISTS teacher_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) console.error('teacher_assignments table error:', err);
    else console.log('teacher_assignments table ready');
  });

  // Student Enrollments
  db.run(`
    CREATE TABLE IF NOT EXISTS student_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE,
      UNIQUE(student_id, course_id, term_id)
      
    )
  `, (err) => {
    if (err) console.error('student_enrollments table error:', err);
    else console.log('student_enrollments table ready');
  });

// === GRADES TABLE: FULL CGPA SUPPORT ===
db.run(`
  CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
   enrollment_id INTEGER,  -- optional, remove NOT NULL
    student_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    term_id INTEGER,
    ca INTEGER DEFAULT 0,
    exam INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    grade TEXT DEFAULT 'F',
    gpa_points INTEGER DEFAULT 0,
    teacher_id INTEGER,
    comments TEXT,
    score INTEGER,  -- legacy field
    UNIQUE(student_id, course_id, term_id),
    FOREIGN KEY (student_id) REFERENCES users(id),
    FOREIGN KEY (course_id) REFERENCES courses(id),
    FOREIGN KEY (teacher_id) REFERENCES users(id),
    FOREIGN KEY (term_id) REFERENCES terms(id)
  )
`, (err) => {
  if (err) {
    console.error('Error creating grades table:', err);
  } else {
    console.log('grades table ready');
  }

  // === MIGRATION: ADD MISSING COLUMNS IF NOT EXIST (FOR OLD DBs) ===
  const requiredColumns = [
    { name: 'ca', type: 'INTEGER DEFAULT 0' },
    { name: 'exam', type: 'INTEGER DEFAULT 0' },
    { name: 'total', type: 'INTEGER DEFAULT 0' },
    { name: 'gpa_points', type: 'INTEGER DEFAULT 0' },
    { name: 'teacher_id', type: 'INTEGER' },
    { name: 'term_id', type: 'INTEGER' }
  ];

  db.all(`PRAGMA table_info(grades)`, (err, rows) => {
    if (err) return console.error('PRAGMA error:', err);

    const existing = rows.map(r => r.name);
    requiredColumns.forEach(col => {
      if (!existing.includes(col.name)) {
        console.log(`Adding missing column: ${col.name}`);
        db.run(`ALTER TABLE grades ADD COLUMN ${col.name} ${col.type}`, (alterErr) => {
          if (alterErr) console.error(`Failed to add ${col.name}:`, alterErr);
        });
      }
    });
  });
});

// === TOPICS TABLE (for teacher to add topics per course) ===
db.run(`
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    topic_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    UNIQUE(course_id, topic_name)
  )
`, (err) => {
  if (err) console.error('Error creating topics table:', err);
  else console.log('topics table ready');
});


db.run(`
    CREATE TABLE IF NOT EXISTS cbt_exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER,
        course_id INTEGER,
        class_id INTEGER,
        title TEXT,
        total_questions INTEGER DEFAULT 0
    )
`);




// === ENSURE enrollment_id EXISTS IN GRADES ===
db.run(`
  ALTER TABLE grades ADD COLUMN enrollment_id INTEGER REFERENCES student_enrollments(id)
`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('Failed to add enrollment_id:', err);
  } else {
    console.log('enrollment_id column ready in grades');
  }
});
// ADD THIS BLOCK EXACTLY HERE
db.run(`
  ALTER TABLE terms ADD COLUMN is_current INTEGER DEFAULT 0
`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    console.error('Failed to add is_current column:', err.message);
  } else {
    console.log('is_current column added to terms table');
  }
});


// Insert default classes (JS1, JS2, ..., SS3) once
function ensureDefaultClasses() {
  const defaultClasses = ['JS1', 'JS2', 'JS3', 'SS1', 'SS2', 'SS3'];
  let inserted = 0;

  defaultClasses.forEach(name => {
    db.run('INSERT OR IGNORE INTO classes (name) VALUES (?)', [name], (err) => {
      if (err) console.error('Failed to insert class:', name, err);
      else inserted++;

      if (inserted === defaultClasses.length) {
        console.log('All default classes (JS1-SS3) inserted');
      }
    });
  });
}


// ──────────────────────────────────────────────────────────────
//  ENSURE ONE CURRENT TERM IS ALWAYS ACTIVE (runs on every start)
// ──────────────────────────────────────────────────────────────
db.run(`UPDATE terms SET is_current = 0`, () => {               // reset all
  db.get(`
    SELECT t.id
    FROM terms t
    JOIN academic_years ay ON t.year_id = ay.id
    WHERE ay.current = 1
    ORDER BY t.term_number ASC
    LIMIT 1
  `, (err, row) => {
    if (err) return console.error('Current‑term query error:', err);
    if (row) {
      const termId = row.id;
      db.run(`UPDATE terms SET is_current = 1 WHERE id = ?`, [termId], () => {
        console.log(`Current term activated → Term ID ${termId}`);
      });
      // keep academic_years in sync
      db.run(`UPDATE academic_years SET current_term_id = ? WHERE current = 1`, [termId]);
    } else {
      console.warn('No term found – create an academic year + term first');
    }
  });
});


// === SET DEFAULT CURRENT TERM ===
db.get(`
  SELECT ay.id as year_id, ay.year, t.id as term_id, t.name, t.term_number
  FROM academic_years ay
  LEFT JOIN terms t ON t.year_id = ay.id
  WHERE ay.current = 1
  ORDER BY ay.year DESC, t.term_number ASC
  LIMIT 1
`, (err, currentTerm) => {
  if (!currentTerm || !currentTerm.term_id) {
    // No current term → set first term of current year
    db.get(`SELECT id FROM academic_years WHERE current = 1`, (err, year) => {
      if (year) {
        db.get(`SELECT id FROM terms WHERE year_id = ? ORDER BY term_number ASC LIMIT 1`, [year.id], (err, firstTerm) => {
          if (firstTerm) {
            db.run(`UPDATE academic_years SET current_term_id = ? WHERE id = ?`, [firstTerm.id, year.id], () => {
              console.log(`Current Term set: First term of ${year.id}`);
            });
          }
        });
      }
    });
  } else {
    console.log(`Current Term already set: ${currentTerm.name} (${currentTerm.year})`);
  }
});

// class_teacher_id
db.run(`
  ALTER TABLE classes ADD COLUMN class_teacher_id INTEGER REFERENCES users(id)
`, (err) => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('Error adding class_teacher_id:', err);
  }
});

// 🔧 ADD term_id TO term_settings (REQUIRED FOR ATTENDANCE)
db.run(`
  ALTER TABLE term_settings
  ADD COLUMN term_id INTEGER
`, err => {
  if (err && !err.message.includes('duplicate column')) {
    console.error('term_id column error:', err.message);
  } else {
    console.log('term_id column ready in term_settings');
  }
});

// 🔧 ENSURE ONE SETTING PER CLASS PER TERM
db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_term_settings_unique
  ON term_settings (class_id, term_id)
`, err => {
  if (err) {
    console.error('term_settings index error:', err.message);
  } else {
    console.log('term_settings unique index ready');
  }
});
// ⚠ CLEAN OLD TERM SETTINGS (RUN ONCE)
db.run(`DELETE FROM term_settings`, err => {
  if (err) {
    console.error('Cleanup error:', err.message);
  } else {
    console.log('Old term_settings cleared');
  }
});



// Run once on startup
ensureDefaultClasses();
});
module.exports = { db, query, run, get };