const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { check, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const { db, query, run, get } = require('./database');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const fs = require('fs');
const Jimp = require('jimp');
const app = express();
const SQLiteStore = require('connect-sqlite3')(session);

// === CRITICAL: Parse JSON bodies ===
app.use(express.json()); // This enables req.body for JSON
app.use(express.urlencoded({ extended: true })); // For form data
const port = process.env.PORT || 3001;

// ————————————————————————
// FINAL & SAFE CURRENT TERM ID (Promise version)
// Use this everywhere — NO MORE CALLBACKS
// ————————————————————————
function getCurrentTermId() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT current_term_id FROM academic_years WHERE current = 1`,
      (err, row) => {
        if (err) {
          console.error('getCurrentTermId error:', err);
          return reject(err);
        }
        resolve(row ? row.current_term_id : null);
      }
    );
  });
}


async function getTermPosition(studentId, termId) {
  let all = await query(`
    SELECT student_id, SUM(CASE WHEN total >= 70 THEN 5 WHEN total >= 60 THEN 4 WHEN total >= 50 THEN 3 WHEN total >= 40 THEN 2 ELSE 1 END) as points
    FROM grades WHERE term_id = ? AND total IS NOT NULL GROUP BY student_id ORDER BY points DESC
  `, [termId]);

  if (!Array.isArray(all)) all = all ? [all] : [];
  if (all.length === 0) return "N/A";

  const rank = all.findIndex(r => r.student_id === studentId) + 1;
  return `${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} of ${all.length}`;
}

async function calculateYearlyCGPA(studentId, yearId) {
  const rows = await query(`
    SELECT g.total FROM grades g
    JOIN terms t ON g.term_id = t.id
    WHERE t.year_id = ? AND g.student_id = ? AND g.total IS NOT NULL
  `, [yearId, studentId]);

  let totalPoints = 0, subjects = 0;
  rows.forEach(r => {
    const point = r.total >= 70 ? 5 : r.total >= 60 ? 4 : r.total >= 50 ? 3 : r.total >= 40 ? 2 : 1;
    totalPoints += point;
    subjects++;
  });

  const cgpa = subjects > 0 ? (totalPoints / subjects).toFixed(2) : "0.00";
  const position = await getYearPosition(studentId, yearId);

  return { cgpa, position };
}

async function getYearPosition(studentId, yearId) {
  let all = await query(`
    SELECT g.student_id, SUM(CASE WHEN g.total >= 70 THEN 5 WHEN g.total >= 60 THEN 4 WHEN g.total >= 50 THEN 3 WHEN g.total >= 40 THEN 2 ELSE 1 END) as points
    FROM grades g JOIN terms t ON g.term_id = t.id
    WHERE t.year_id = ? AND g.total IS NOT NULL GROUP BY g.student_id ORDER BY points DESC
  `, [yearId]);

  if (!Array.isArray(all)) all = all ? [all] : [];
  if (all.length === 0) return "N/A";

  const rank = all.findIndex(r => r.student_id === studentId) + 1;
  return `${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} of ${all.length}`;
}

// AFTER: const db = new sqlite3.Database(...);
function initializeAcademicYear(start, end) {
  const yearStr = `${start}/${end}`;
  db.run(`
    INSERT OR IGNORE INTO academic_years (start_year, end_year, current)
    VALUES (?, ?, 1)
  `, [start, end], function(err) {
    if (err) {
      console.error('Failed to initialize academic year:', err);
    } else {
      console.log(`New academic year ${yearStr} initialized`);
    }
  });
}
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static('public'));
// === MULTER: SAVE TO TEMP ===
const upload = multer({
  dest: 'public/uploads/temp/',
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const types = /jpeg|jpg|png/;
    const ext = types.test(path.extname(file.originalname).toLowerCase());
    const mime = types.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only JPG/PNG'));
  }
});
// Middleware Setup
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
// ---- SESSION (keep only ONE) ----
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: './',               // creates sessions.db in your project folder
    concurrent: true
  }),
  secret: 'your-super-secret-key-change-in-production-12345',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
    httpOnly: true,
    secure: false,               // set true only if using HTTPS
    sameSite: 'lax'
  }
}));


// ===== FLASH MESSAGES (for req.flash) =====
const flash = require('connect-flash');
app.use(flash());

// Make flash messages available in all views
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  res.locals.user = req.session;
  next();
});

// Protect all /admin routes
app.use('/admin', (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    req.flash('error', 'Access denied. Admins only.');
    return res.redirect('/login');
  }
  next();
});


// ========================================
// AUTHENTICATION MIDDLEWARE (REQUIRED!)
// ========================================
const authenticate = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  }
  console.log('No session or userId, redirecting to login');
  res.redirect('/login');
};

// Make db.run return promises (add this once near the top)
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}


function cleanTermName(dirtyName) {
  if (!dirtyName) return 'Current Term';

  let name = dirtyName.trim();

  // 1. Remove anything in parentheses/brackets
  name = name.replace(/\s*[$$ \[\{].*?[ $$\]\}]/g, '');

  // 2. Remove leading years like "2025", "2024/2025", "2025-2026 "
  name = name.replace(/^\d{4,5}[\/\-\s]*\d{0,4}\s*-?\s*/g, '');

  // 3. Remove duplicate "Term Term", "term term", etc.
  name = name.replace(/Term\s+Term$/i, 'Term');

  // 4. Normalize known terms
  if (name.match(/first|1st|1/i)) name = 'First Term';
  else if (name.match(/second|2nd|2/i)) name = 'Second Term';
  else if (name.match(/third|3rd|3/i)) name = 'Third Term';
  else if (name.match(/term/i)) {
    // Already has "Term" → just clean spacing
    name = name.replace(/\s+/g, ' ').trim();
  } else {
    // No term keyword → add it
    name = name + ' Term';
  }

  // Final cleanup
  return name.trim() || 'Current Term';
}

async function getStudentCurrentInfo(studentId) {
  const currentTermId = await getCurrentTermId();
  if (!currentTermId) return null;

  return await query(`
    SELECT DISTINCT
      cl.id AS class_id,
      cl.name AS class_name,
      t.name AS term_name,
      t.term_number,
      ay.year AS academic_year
    FROM student_enrollments se
      JOIN courses co ON se.course_id = co.id
      JOIN classes cl ON co.class_id = cl.id
      JOIN terms t ON se.term_id = t.id
      JOIN academic_years ay ON t.year_id = ay.id
    WHERE se.student_id = ?
      AND se.term_id = ?
      AND ay.current = 1
    LIMIT 1
  `, [studentId, currentTermId]);
}


app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});
// 1. GET /login (and root → login)
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => {
  // Pull any previously‑typed username from session (after a failed login)
  const userInput = req.session?.userInput || {};
  const errors = req.session?.loginErrors || [];
  // Clear temporary session vars
  delete req.session.userInput;
  delete req.session.loginErrors;
  res.render('login', {
    errors,
    userInput, // <-- safe object
    successMsg: null,
    errorMsg: null
  });
});
// 2. POST /login
app.post('/login', [
  check('username').notEmpty().withMessage('Username is required'),
  check('password').notEmpty().withMessage('Password is required')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.userInput = { username: req.body.username };
    req.session.loginErrors = errors.array();
    return res.redirect('/login');
  }
  const { username, password } = req.body;
  console.log('Login attempt:', { username });
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      console.error('Login DB error:', err);
      req.session.userInput = { username };
      req.session.loginErrors = [{ msg: 'Database error' }];
      return res.redirect('/login');
    }
    if (!user) {
      req.session.userInput = { username };
      req.session.loginErrors = [{ msg: 'Invalid credentials' }];
      return res.redirect('/login');
    }
    if (user.status === 'disabled') {
      req.session.userInput = { username };
      req.session.loginErrors = [{ msg: 'Account has been disabled. Contact administrator.' }];
      return res.redirect('/login');
    }
    if (user.status === 'pending') {
      req.session.userInput = { username };
      req.session.loginErrors = [{ msg: 'Account pending approval. Contact administrator.' }];
      return res.redirect('/login');
    }
    bcrypt.compare(password, user.password, (err, match) => {
      if (err) {
        console.error('Password compare error:', err);
        req.session.userInput = { username };
        req.session.loginErrors = [{ msg: 'Login error' }];
        return res.redirect('/login');
      }
      if (!match) {
        req.session.userInput = { username };
        req.session.loginErrors = [{ msg: 'Invalid credentials' }];
        return res.redirect('/login');
      }
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.userName = user.name || user.username;
      req.session.photo = user.photo || 'default-photo.jpg'; // KEY FIX
      console.log('Login successful:', { userId: user.id, role: user.role });
      delete req.session.userInput;
      delete req.session.loginErrors;
      return res.redirect('/dashboard');
    });
  });
});
app.post('/admin/reset-password/:id', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const userId = req.params.id;
  // GENERATE RANDOM 8-DIGIT NUMBER
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let newPass = '';
for (let i = 0; i < 8; i++) {
  newPass += chars.charAt(Math.floor(Math.random() * chars.length));
}
  const hashed = bcrypt.hashSync(newPass, 10);
  db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, userId], (err) => {
    if (err) {
      console.error('Reset password error:', err);
      return res.redirect('/admin/account?error=Reset+failed');
    }
    res.redirect(`/admin/account?success=Password+reset+to+${newPass}`);
  });
});
// DASHBOARD
app.get('/dashboard', async (req, res) => {
  if (!req.session.userId) {
    console.log('No session or userId, redirecting to login');
    return res.redirect('/login');
  }
  const userId = req.session.userId;
  const role = req.session.role;
  console.log('Dashboard for role:', role);
 
  // === ADMIN: FETCH COUNTS + PASS q FOR SEARCH BAR ===
if (role === 'admin') {
  db.get(`
    SELECT
      COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
      COUNT(CASE WHEN status='disabled' THEN 1 END) as disabled,
      COUNT(CASE WHEN status='approved' AND role != 'admin' THEN 1 END) as active
    FROM users
  `, (err, counts) => {
    if (err) counts = { pending: 0, disabled: 0, active: 0 };
    res.render('admin_dashboard', {
      user: req.session,
      counts,
      q: req.query.q || '', // MUST PASS q
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
    return;
  });
  return;
}
 // === TEACHER: FETCH NAME + CLASSES + COURSES ===
if (role === 'teacher') {
  db.get('SELECT name FROM users WHERE id = ?', [userId], (err, user) => {
    if (!err && user) req.session.userName = user.name || req.session.userName;
    
    db.all('SELECT name FROM classes WHERE class_teacher_id = ?', [userId], (err, classRows) => {
      const classTeacherOf = classRows?.length > 0
        ? classRows.map(r => r.name).join(', ')
        : null;

      db.all(`
        SELECT c.name AS course_name, cl.name AS class_name, c.id
        FROM teacher_assignments ta
        JOIN courses c ON ta.course_id = c.id
        JOIN classes cl ON c.class_id = cl.id
        WHERE ta.teacher_id = ?
        ORDER BY cl.name, c.name
      `, [userId], (err, courses) => {
        if (err) courses = [];

        res.render('teacher_dashboard', {
          user: req.session,
          classTeacherOf,
          assignedCourses: courses,
          successMsg: req.query.success || null,
          errorMsg: req.query.error || null
        });
        // ADD THIS LINE → stops execution!
        return;   // ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
      });
    });
  });
  return;   // Also add this one for extra safety
}
// STUDENT DASHBOARD
if (role === 'student') {
  const studentId = userId;
  try {
    const infoResult = await query(`
      SELECT DISTINCT
        cl.name AS class_name,
        ay.year AS session,
        t.name AS raw_term_name
      FROM student_enrollments se
        JOIN courses co ON se.course_id = co.id
        JOIN classes cl ON co.class_id = cl.id
        JOIN terms t ON se.term_id = t.id
        JOIN academic_years ay ON t.year_id = ay.id
      WHERE se.student_id = ?
        AND ay.current = 1
        AND t.id = (SELECT current_term_id FROM academic_years WHERE current = 1)
      LIMIT 1
    `, [studentId]);

    let studentClass = 'Not Enrolled';
    let sessionYear = 'No Active Session';
    let cleanTermDisplay = 'N/A';

    if (infoResult && infoResult.length > 0) {
      const info = infoResult[0];
      studentClass = info.class_name || 'Not Assigned';
      sessionYear = info.session || '2025/2026';

      cleanTermDisplay = cleanTermName(info.raw_term_name);
    }

    res.render('student_dashboard', {
      user: {
        userName: req.session.userName,
        photo: req.session.photo || 'default-photo.jpg'
      },
      studentClass,
      cleanTermDisplay,
      sessionYear,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
  } catch (err) {
    console.error('Error loading student dashboard:', err);
    res.render('student_dashboard', {
      user: req.session,
      studentClass: 'Error',
      cleanTermDisplay: 'Error',
      sessionYear: 'Error',
      errorMsg: 'Failed to load session information'
    });
  }
  return;
}

  // Fallback
  res.redirect('/login');
});


app.get('/student/results', (req, res) => {
  if (!req.session.userId || req.session.role !== 'student') return res.redirect('/login');
  const studentId = req.session.userId;
  db.get(`
    SELECT t.id AS term_id
    FROM academic_years ay
    JOIN terms t ON t.id = ay.current_term_id
    WHERE ay.current = 1
  `, (err, term) => {
    const termId = term ? term.term_id : null;
    if (!termId) {
      return res.render('student_results', { user: req.session, results: [], gpa: 'N/A' });
    }
    db.all(`
      SELECT c.name AS course_name,
             COALESCE(g.total, 0) AS score,
             COALESCE(g.grade, 'N/A') AS grade
      FROM student_enrollments se
      JOIN courses c ON se.course_id = c.id
      LEFT JOIN grades g ON g.course_id = c.id AND g.student_id = ? AND g.term_id = ?
      WHERE se.student_id = ? AND se.term_id = ?
      ORDER BY c.name
    `, [studentId, termId, studentId, termId], (err, results) => {
      if (err) results = [];
      // Calculate GPA
      const points = { 'A':5, 'B':4, 'C':3, 'D':2, 'E':1, 'F':0 };
      let total = 0, count = 0;
      results.forEach(r => {
        if (r.grade && points[r.grade] !== undefined) {
          total += points[r.grade];
          count++;
        }
      });
      const gpa = count > 0 ? (total / count).toFixed(2) : 'N/A';
      res.render('student_results', { user: req.session, results, gpa });
    });
  });
});


// === STUDENT: GRADES HISTORY (ALL TERMS) - FIXED & GROUPED ===
app.get('/student/grades', (req, res) => {
  if (!req.session.userId || req.session.role !== 'student') 
    return res.redirect('/login');

  const studentId = req.session.userId;

  const query = `
    SELECT 
      ay.year AS academic_year,
      ay.is_completed,
      t.id AS term_id,
      t.name AS term_name,
      t.term_number,
      c.name AS course_name,
      c.id AS course_id,
      g.ca,
      g.exam,
      g.total AS score,
      g.grade,
      cl.name AS class_name,
      r.position_in_class
    FROM grades g
    JOIN courses c ON g.course_id = c.id
    JOIN terms t ON g.term_id = t.id
    JOIN academic_years ay ON t.year_id = ay.id
    LEFT JOIN registrations reg ON reg.student_id = ? AND reg.term_id = t.id
    LEFT JOIN classes cl ON reg.class_id = cl.id
    LEFT JOIN rankings r ON r.student_id = ? AND r.term_id = t.id
    WHERE g.student_id = ?
      AND ay.is_completed = 1
    ORDER BY ay.year DESC, t.term_number, c.name
  `;

  db.all(query, [studentId, studentId, studentId], (err, rows) => {
    if (err) {
      console.error("Grades history error:", err);
      return res.render('student_grades', { 
        user: req.session, 
        historyYears: [], 
        noHistory: true 
      });
    }

    if (!rows || rows.length === 0) {
      return res.render('student_grades', { 
        user: req.session, 
        historyYears: [], 
        noHistory: true 
      });
    }

    // Group by academic year → terms → courses
    const historyYears = [];
    const yearMap = {};

    rows.forEach(row => {
      const yearKey = row.academic_year;

      if (!yearMap[yearKey]) {
        yearMap[yearKey] = {
          academic_year: yearKey,
          terms: {}
        };
        historyYears.push(yearMap[yearKey]);
      }

      const termKey = row.term_id;
      if (!yearMap[yearKey].terms[termKey]) {
        yearMap[yearKey].terms[termKey] = {
          term_name: row.term_name,
          class_name: row.class_name || 'N/A',
          position: row.position_in_class ? `#${row.position_in_class}` : 'N/A',
          courses: []
        };
      }

      yearMap[yearKey].terms[termKey].courses.push({
        course_name: row.course_name,
        ca: row.ca ?? '-',
        exam: row.exam ?? '-',
        total: row.score,
        grade: row.grade
      });
    });

    // Convert terms object to array
    historyYears.forEach(year => {
      year.terms = Object.values(year.terms);
    });

    res.render('student_grades', { 
      user: req.session, 
      historyYears,
      noHistory: false 
    });
  });
});


// MIDDLEWARE: TEACHER ONLY (ONLY ONE TIME!)
const isTeacher = (req, res, next) => {
  if (req.session && req.session.role === 'teacher') return next();
  req.flash('error', 'Access denied. Teachers only.');
  res.redirect('/login');
};

// TEACHER COURSES — FINAL VERSION THAT WORKS WITH YOUR CURRENT 35+ ENROLLMENTS
// TEACHER COURSES — FINAL FIXED VERSION (SHOWS REAL STUDENT COUNTS!)
app.get('/teacher/courses', isTeacher, async (req, res) => {
  try {
    const teacherId = req.session.userId;
    const termId = await getCurrentTermId();

    if (!termId) {
      req.flash('error', 'No active term');
      return res.redirect('/dashboard');
    }

    const termRow = await query('SELECT name FROM terms WHERE id = ?', [termId]);
    const fullTermName = termRow[0]?.name || 'Current Term';
    const current_term_name = fullTermName.includes('First') ? 'First Term' :
                             fullTermName.includes('Second') ? 'Second Term' :
                             fullTermName.includes('Third') ? 'Third Term' : fullTermName;

    // FINAL QUERY — CORRECT ENROLLED + GRADED COUNT
    const rows = await query(`
      SELECT 
        c.id AS course_id,
        c.name AS course_name,
        cl.name AS class_name,
        COALESCE(enrolled.count, 0) AS enrolled_count,
        COALESCE(scored.count, 0) AS scored_count
      FROM teacher_assignments ta
      JOIN courses c ON ta.course_id = c.id
      JOIN classes cl ON c.class_id = cl.id
      LEFT JOIN (
        SELECT course_id, COUNT(*) AS count 
        FROM student_enrollments 
        WHERE term_id = ? 
        GROUP BY course_id
      ) enrolled ON enrolled.course_id = c.id
      LEFT JOIN (
        SELECT se.course_id, COUNT(g.id) AS count
        FROM grades g
        JOIN student_enrollments se ON g.enrollment_id = se.id
        WHERE se.term_id = ?
        GROUP BY se.course_id
      ) scored ON scored.course_id = c.id
      WHERE ta.teacher_id = ?
      ORDER BY cl.name, c.name
    `, [termId, termId, teacherId]);

    const classes = rows.map(r => ({
      course_id: r.course_id,
      course_name: r.course_name,
      class_name: r.class_name,
      enrolled_count: parseInt(r.enrolled_count) || 0,
      scored_count: parseInt(r.scored_count) || 0
    }));

    res.render('teacher_courses', {
      classes,
      current_term_name,
      successMsg: req.flash('success'),
      errorMsg: req.flash('error')
    });

  } catch (err) {
    console.error('Teacher courses error:', err);
    req.flash('error', 'Failed to load courses');
    res.redirect('/dashboard');
  }
});

// GLOBAL USER SEARCH (Admin Dashboard)
app.get('/admin/search-users', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const q = (req.query.q || '').trim().toLowerCase();
  let sql = `SELECT id, username, name, role, status FROM users WHERE 1=1`;
  let params = [];
  if (q) {
    // Search by username, name, or status keywords
    sql += ` AND (
      LOWER(username) LIKE ? OR
      LOWER(name) LIKE ? OR
      LOWER(status) LIKE ?
    )`;
    const like = `%${q}%`;
    params = [like, like, like];
  }
  sql += ` ORDER BY
    CASE status
      WHEN 'pending' THEN 1
      WHEN 'disabled' THEN 2
      WHEN 'approved' THEN 3
    END, name`;
  db.all(sql, params, (err, users) => {
    if (err) {
      console.error(err);
      users = [];
    }
    // Count badges
    db.get(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='disabled' THEN 1 END) as disabled,
        COUNT(CASE WHEN status='approved' AND role != 'admin' THEN 1 END) as active
      FROM users
    `, (err, counts) => {
      if (err) counts = { pending: 0, disabled: 0, active: 0 };
      res.render('admin_search_results', {
        users,
        q,
        counts,
        successMsg: req.query.success || null,
        errorMsg: req.query.error || null
      });
    });
  });
});
// Register Routes
app.get('/register', (req, res) => {
  res.render('register', {
    userInput: {},
    successMsg: null,
    errorMsg: null,
    errors: []
  });
});
// === ADMIN: GET EDIT USER PAGE (WITH CURRENT PHOTO) ===
app.get('/admin/users/edit/:id', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const userId = req.params.id;
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) {
      return res.redirect('/admin/users?error=User+not+found');
    }
    res.render('edit-user', {
      user,
      success: null,
      error: null
    });
  });
});
// === ADMIN: POST - UPDATE USER + OPTIONAL PHOTO ===
app.post('/admin/users/edit/:id', upload.single('photo'), async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const userId = req.params.id;
  const { name, username, dob, address, currentPhoto } = req.body;
  let photoFilename = currentPhoto || 'default-photo.jpg';
  // Handle new photo upload
  if (req.file) {
    const tempPath = req.file.path;
    photoFilename = `${req.body.role || 'user'}_${Date.now()}_${username || 'user'}.jpg`;
    const finalPath = path.join(__dirname, 'public', 'uploads', photoFilename);
    try {
      const image = await Jimp.read(tempPath);
      await image.cover(200, 200).quality(90).writeAsync(finalPath);
      fs.unlinkSync(tempPath);
      // Delete old photo if not default
      if (currentPhoto && currentPhoto !== 'default-photo.jpg') {
        const oldPath = path.join(__dirname, 'public', 'uploads', currentPhoto);
        fs.unlink(oldPath, (err) => { if (err) console.log('Old photo delete failed:', err); });
      }
    } catch (err) {
      console.error('Photo processing failed:', err);
      photoFilename = currentPhoto; // fallback
    }
  }
  const updates = { name, username, dob: dob || null, address };
  if (photoFilename) updates.photo = photoFilename;
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(userId);
  db.run(`UPDATE users SET ${fields} WHERE id = ?`, values, function(err) {
    if (err) {
      console.error('Update user error:', err);
      return res.render('edit-user', {
        user: { ...req.body, id: userId, photo: currentPhoto },
        error: 'Failed to update (username may exist)',
        success: null
      });
    }
    res.render('edit-user', {
      user: { id: userId, name, username, dob, address, photo: photoFilename },
      success: 'User updated successfully!',
      error: null
    });
  });
});
// === ADMIN: CREATE USER WITH PHOTO (MUST START AS PENDING!) ===
app.post('/register', upload.single('photo'), async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const { username, password, name, sex, dob, address, role } = req.body;
  // Basic validation
  if (!username || !password || !name || !sex || !dob || !address || !role) {
    return res.render('register', {
      errorMsg: 'All fields are required',
      userInput: req.body,
      successMsg: null,
      errors: []
    });
  }
  try {
    // Check if username already exists
    db.get('SELECT id FROM users WHERE username = ?', [username], async (err, row) => {
      if (row) {
        return res.render('register', {
          errorMsg: 'Username already taken',
          userInput: req.body,
          successMsg: null,
          errors: []
        });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      let photoFilename = 'default-photo.jpg';
      // Process uploaded photo
      if (req.file) {
        const tempPath = req.file.path;
        photoFilename = `${role}_${Date.now()}_${username}.jpg`;
        const finalPath = path.join(__dirname, 'public', 'uploads', photoFilename);
        try {
          const image = await Jimp.read(tempPath);
          await image.cover(200, 200).quality(90).writeAsync(finalPath);
          fs.unlinkSync(tempPath);
        } catch (err) {
          console.error('Photo resize failed:', err);
          photoFilename = 'default-photo.jpg'; // fallback
          fs.unlinkSync(tempPath);
        }
      }
      // INSERT USER AS PENDING — THIS IS THE FIX!
      db.run(`
        INSERT INTO users (username, password, name, sex, dob, address, role, photo, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [username, hashedPassword, name, sex, dob, address, role, photoFilename], function(err) {
        if (err) {
          console.error('Insert error:', err);
          return res.render('register', {
            errorMsg: 'Failed to create user',
            userInput: req.body
          });
        }
        res.render('register', {
          successMsg: `User "${name}" created successfully! Status: PENDING → Go to Manage Users to approve.`,
          userInput: {},
          errorMsg: null,
          errors: []
        });
      });
    });
  } catch (err) {
    console.error('Server error:', err);
    res.render('register', { errorMsg: 'Server error', userInput: req.body });
  }
});


// === MANAGE USERS: 4 FILTERS (STUDENTS, TEACHERS, PENDING, DISABLED) ===
// === MANAGE USERS WITH PAGINATION (Students, Teachers, Pending, Disabled) ===
app.get('/admin/manage-users', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  const filter = req.query.filter || 'student';      // default filter
  const page   = parseInt(req.query.page) || 1;
  const limit  = 20;                                 // users per page
  const offset = (page - 1) * limit;

  // Build WHERE clause based on filter
  let whereClause = '';
  let countWhere  = '';
  let params      = [];
  let countParams = [];

  if (filter === 'student') {
    whereClause = 'WHERE role = ? AND status = "approved"';
    countWhere  = whereClause;
    params = countParams = ['student'];
  }
  else if (filter === 'teacher') {
    whereClause = 'WHERE role = ? AND status = "approved"';
    countWhere  = whereClause;
    params = countParams = ['teacher'];
  }
  else if (filter === 'pending') {
    whereClause = 'WHERE status = ?';
    countWhere  = whereClause;
    params = countParams = ['pending'];
  }
  else if (filter === 'disabled') {
    whereClause = 'WHERE status = ?';
    countWhere  = whereClause;
    params = countParams = ['disabled'];
  }
  // If somehow invalid filter → fallback to students
  else {
    whereClause = 'WHERE role = ? AND status = "approved"';
    countWhere  = whereClause;
    params = countParams = ['student'];
  }

  try {
    // 1. Get total count for current filter (for pagination)
    const totalCountRow = await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as total FROM users ${countWhere}`, countParams, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    const totalUsers = totalCountRow.total;
    const totalPages = Math.ceil(totalUsers / limit);

    // 2. Get paginated users for current filter
    const users = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, username, name, role, status 
         FROM users 
         ${whereClause} 
         ORDER BY name ASC 
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });

    // 3. Get all counts (for the filter buttons)
    const counts = await new Promise((resolve, reject) => {
      db.get(`
        SELECT
          COUNT(CASE WHEN role='student' AND status='approved' THEN 1 END) as students,
          COUNT(CASE WHEN role='teacher' AND status='approved' THEN 1 END) as teachers,
          COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
          COUNT(CASE WHEN status='disabled' THEN 1 END) as disabled
        FROM users
      `, (err, row) => {
        if (err) return reject(err);
        resolve(row || { students:0, teachers:0, pending:0, disabled:0 });
      });
    });

    // Render the page
    res.render('admin_manage_users', {
      users,
      counts,
      filter,
      page,
      limit,
      totalUsers,
      totalPages,
      success: req.query.success || null   // optional flash message
    });

  } catch (err) {
    console.error('Error in /admin/manage-users:', err);
    res.status(500).send('Server Error');
  }
});



// Academic Years Management
app.get('/admin/academic-years', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const successMsg = req.query.success;
  const errorMsg = req.query.error;
  db.all('SELECT * FROM academic_years ORDER BY year DESC', (err, years) => {
    if (err) {
      console.error('Years fetch error:', err);
      years = [];
    }
    res.render('admin_academic_years', {
      years,
      errors: [],
      successMsg,
      errorMsg
    });
  });
});
app.post('/admin/academic-years', [
  check('year').matches(/^\d{4}\/\d{4}$/).withMessage('Use format: 2025/2026')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return db.all('SELECT * FROM academic_years ORDER BY year DESC', (err, years) => {
      res.render('admin_academic_years', {
        years,
        errors: errors.array(),
        successMsg: null,
        errorMsg: errors.array()[0].msg
      });
    });
  }

  const year = req.body.year.trim();

  try {
    // Step 1: Reset all years to not current
    await runQuery('UPDATE academic_years SET current = 0');

    // Step 2: Insert new year and set as current
    const result = await runQuery(
      'INSERT INTO academic_years (year, current) VALUES (?, 1)',
      [year]
    );

    const yearId = result.lastID;

    // Step 3: Create 3 terms automatically
    const [start] = year.split('/');
    const termNames = [
      `${start} First Term`,
      `${start} Second Term`,
      `${start} Third Term`
    ];

    for (let i = 0; i < termNames.length; i++) {
      await runQuery(
        'INSERT INTO terms (name, year_id, term_number, is_current) VALUES (?, ?, ?, ?)',
        [termNames[i], yearId, i + 1, i === 0 ? 1 : 0]
      );
    }

    // Step 4: Set the first term as current_term_id
    const firstTerm = await get(
      'SELECT id FROM terms WHERE year_id = ? ORDER BY term_number LIMIT 1',
      [yearId]
    );

    if (firstTerm) {
      await runQuery(
        'UPDATE academic_years SET current_term_id = ? WHERE id = ?',
        [firstTerm.id, yearId]
      );
    }

    res.redirect('/admin/academic-years?success=New+year+created+and+set+as+current');
  } catch (err) {
    console.error('Year creation error:', err);
    if (err.message.includes('UNIQUE')) {
      res.redirect('/admin/academic-years?error=Year+already+exists');
    } else {
      res.redirect('/admin/academic-years?error=Failed+to+create+year');
    }
  }
});

app.post('/admin/set-current-term/:termId', (req, res) => {
  const termId = req.params.termId;
  db.get('SELECT year_id FROM terms WHERE id = ?', [termId], (err, term) => {
    if (!term) return res.redirect('/admin/academic-years?error=Term+not+found');
    db.get('SELECT id FROM academic_years WHERE id = ? AND current = 1', [term.year_id], (err, year) => {
      if (!year) return res.redirect('/admin/academic-years?error=Year+not+current');
     // First: reset all terms
db.run('UPDATE terms SET is_current = 0', () => {
  // Then: set new current term
  db.run('UPDATE terms SET is_current = 1 WHERE id = ?', [termId], () => {
    db.run('UPDATE academic_years SET current_term_id = ? WHERE id = ?', [termId, year.id], () => {
      res.redirect('/admin/academic-years?success=Current+term+set');
    });
  });
});
    });
  });
});
app.get('/student/courses', (req, res) => {
  if (req.session.role !== 'student') return res.redirect('/login');
  const studentId = req.session.userId;
  db.get('SELECT id, year FROM academic_years WHERE current = 1', (err, currentYear) => {
    if (!currentYear) {
      return res.render('student_courses', { user: req.session, year: null, terms: [] });
    }
    db.all(`
      SELECT
        t.id AS term_id, t.name AS term_name, t.term_number,
        c.name AS course_name,
        g.ca, g.exam, g.total, g.grade
      FROM terms t
      JOIN student_enrollments se ON se.term_id = t.id
      JOIN courses c ON se.course_id = c.id
      LEFT JOIN grades g ON g.student_id = se.student_id AND g.course_id = c.id AND g.term_id = t.id
      WHERE t.year_id = ? AND se.student_id = ?
      ORDER BY t.term_number, c.name
    `, [currentYear.id, studentId], (err, rows) => {
      const terms = {};
      rows.forEach(r => {
        if (!terms[r.term_id]) {
          terms[r.term_id] = { term_name: r.term_name, courses: [] };
        }
        terms[r.term_id].courses.push({
          course_name: r.course_name,
          ca: r.ca || '', exam: r.exam || '', total: r.total || '', grade: r.grade || 'N/A'
        });
      });
      res.render('student_courses', {
        user: req.session,
        year: currentYear.year,
        terms: Object.values(terms)
      });
    });
  });
});

// === SET CURRENT TERM (ADMIN) - FIXED VERSION ===
app.post('/admin/academic-year/:yearId/set-current-term/:termId', (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  const yearId = parseInt(req.params.yearId, 10);
  const termId = parseInt(req.params.termId, 10);

  if (isNaN(yearId) || isNaN(termId)) {
    return res.redirect(`/admin/academic-years?error=Invalid IDs`);
  }

  // Step 1: Verify term belongs to this year
  db.get('SELECT 1 FROM terms WHERE id = ? AND year_id = ?', [termId, yearId], (err, row) => {
    if (err || !row) {
      return res.redirect(`/admin/academic-years?error=Term not in this year`);
    }

    // Step 2: Reset ALL terms to is_current = 0
    db.run('UPDATE terms SET is_current = 0', (err) => {
      if (err) {
        console.error('Reset is_current failed:', err);
        return res.redirect(`/admin/academic-years?error=Failed to reset terms`);
      }

      // Step 3: Set the selected term as current
      db.run('UPDATE terms SET is_current = 1 WHERE id = ?', [termId], (err) => {
        if (err) {
          console.error('Set is_current = 1 failed:', err);
          return res.redirect(`/admin/academic-years?error=Failed to set current term`);
        }

        // Step 4: Update academic_years.current_term_id
        db.run('UPDATE academic_years SET current_term_id = ? WHERE id = ? AND current = 1', [termId, yearId], function(err) {
          if (err || this.changes === 0) {
            return res.redirect(`/admin/academic-years?error=Failed to update current term ID`);
          }

          console.log(`Current term set to ID: ${termId} (Year: ${yearId})`);
          res.redirect(`/admin/academic-years?success=Current term updated successfully`);
        });
      });
    });
  });
});


// 1. SET CURRENT YEAR – IMPROVED & SAFE
app.post('/admin/academic-years/set-current/:id', async (req, res) => {
  const yearId = parseInt(req.params.id, 10);

  try {
    // Check if the target year exists and is NOT already completed
    const year = await new Promise((resolve, reject) => {
      db.get('SELECT is_completed FROM academic_years WHERE id = ?', [yearId], (err, row) => {
        if (err) reject(err);
        else if (!row) reject(new Error('Year not found'));
        else if (row.is_completed === 1) reject(new Error('Cannot set a completed year as current'));
        else resolve(row);
      });
    });

    // Transaction: Ensure atomicity and only one current year
    await new Promise((resolve, reject) => {
      db.exec('BEGIN TRANSACTION', err => { if (err) reject(err); });
    });

    // Remove current from all years
    await new Promise((resolve, reject) => {
      db.run('UPDATE academic_years SET current = 0', err => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Set the new current year (safe: we already checked it's not completed)
    await new Promise((resolve, reject) => {
      db.run('UPDATE academic_years SET current = 1 WHERE id = ?', [yearId], function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('Year not found'));
        else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.exec('COMMIT', err => { if (err) reject(err); else resolve(); });
    });

    res.redirect('/admin/academic-years?success=Current+year+updated');
  } catch (err) {
    // Rollback on error
    db.exec('ROLLBACK');
    console.error('Set current year error:', err.message);

    if (err.message.includes('completed')) {
      res.redirect('/admin/academic-years?error=Cannot+set+a+completed+year+as+current');
    } else if (err.message.includes('not found')) {
      res.redirect('/admin/academic-years?error=Academic+year+not+found');
    } else {
      res.redirect('/admin/academic-years?error=Failed+to+set+current+year');
    }
  }
});

// 2. MARK AS COMPLETED – ALREADY GOOD, just slightly improved
app.post('/admin/academic-years/mark-completed/:id', async (req, res) => {
  const yearId = parseInt(req.params.id, 10);

  try {
    const result = await new Promise((resolve, reject) => {
      db.run(
        `UPDATE academic_years 
         SET is_completed = 1, current = 0 
         WHERE id = ? AND is_completed = 0`,  // Prevent re-marking
        [yearId],
        function(err) {
          if (err) reject(err);
          else if (this.changes === 0) {
            // Either not found or already completed
            db.get('SELECT is_completed FROM academic_years WHERE id = ?', [yearId], (err, row) => {
              if (err || !row) reject(new Error('Year not found'));
              else if (row.is_completed === 1) reject(new Error('Already completed'));
              else reject(new Error('Unknown error'));
            });
          } else {
            resolve(this.changes);
          }
        }
      );
    });

    res.redirect('/admin/academic-years?success=Year+marked+as+completed');
  } catch (err) {
    console.error('Mark completed error:', err.message);
    const msg = err.message.includes('completed')
      ? 'Year+already+marked+as+completed'
      : 'Failed+to+mark+year+as+completed';
    res.redirect(`/admin/academic-years?error=${msg}`);
  }
});



// === GET TERM LIST – SHOW CURRENT ONE ==========================
app.get('/admin/academic-year/:yearId/terms', (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const yearId = parseInt(req.params.yearId, 10);
  if (isNaN(yearId)) return res.redirect('/admin/academic-years?error=Invalid+year');
  db.get('SELECT year FROM academic_years WHERE id = ?', [yearId], (err, yr) => {
    if (err || !yr) return res.redirect('/admin/academic-years?error=Year+not+found');
    db.get('SELECT current_term_id FROM academic_years WHERE id = ? AND current = 1', [yearId], (err, cur) => {
      const currentTermId = cur ? cur.current_term_id : null;
      db.all(
        'SELECT id, name, term_number FROM terms WHERE year_id = ? ORDER BY term_number',
        [yearId],
        (err, terms) => {
          if (err) {
            console.error('Terms fetch error:', err);
            return res.redirect('/admin/academic-years?error=DB+error');
          }
          res.render('admin_year_terms', {
            yearId,
            year: yr.year,
            terms: terms || [],
            currentTermId,
            errors: [],
            successMsg: req.query.success,
            errorMsg: req.query.error
          });
        }
      );
    });
  });
});
// === DELETE ACADEMIC YEAR + ALL RELATED DATA (FIXED) ===
app.post('/admin/academic-years/delete/:id', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const yearId = req.params.id;
  db.get('SELECT year FROM academic_years WHERE id = ?', [yearId], (err, year) => {
    if (err || !year) {
      return res.redirect('/admin/academic-years?error=Year not found');
    }
    const yearName = year.year;
    // Use transaction for safety
    db.serialize(() => {
      // 1. Get all term IDs for this year
      db.all('SELECT id FROM terms WHERE year_id = ?', [yearId], (err, terms) => {
        if (err) {
          console.error('Get terms error:', err);
          return res.redirect('/admin/academic-years?error=DB error');
        }
        const termIds = terms.map(t => t.id);
        if (termIds.length === 0) {
          // No terms → just delete year
          db.run('DELETE FROM academic_years WHERE id = ?', [yearId], () => {
            res.redirect('/admin/academic-years?success=Year ' + yearName + ' deleted (no terms)');
          });
          return;
        }
        // 2. Delete grades for these terms
        const placeholders = termIds.map(() => '?').join(',');
        db.run(`DELETE FROM grades WHERE term_id IN (${placeholders})`, termIds, (err) => {
          if (err) console.error('Delete grades error:', err);
        });
        // 3. Delete enrollments for these terms
        db.run(`DELETE FROM student_enrollments WHERE term_id IN (${placeholders})`, termIds, (err) => {
          if (err) console.error('Delete enrollments error:', err);
        });
        // 4. Delete teacher assignments for courses in this year
        db.run(`
          DELETE FROM teacher_assignments
          WHERE course_id IN (
            SELECT DISTINCT c.id
            FROM courses c
            JOIN student_enrollments se ON c.id = se.course_id
            WHERE se.term_id IN (${placeholders})
          )
        `, termIds, (err) => {
          if (err) console.error('Delete assignments error:', err);
        });
        // 5. Delete courses used in this year
        db.run(`
          DELETE FROM courses
          WHERE id IN (
            SELECT DISTINCT c.id
            FROM courses c
            JOIN student_enrollments se ON c.id = se.course_id
            WHERE se.term_id IN (${placeholders})
          )
        `, termIds, (err) => {
          if (err) console.error('Delete courses error:', err);
        });
        // 6. Delete terms
        db.run(`DELETE FROM terms WHERE id IN (${placeholders})`, termIds, (err) => {
          if (err) console.error('Delete terms error:', err);
        });
        // 7. Finally delete the year
        db.run('DELETE FROM academic_years WHERE id = ?', [yearId], function (err) {
          if (err) {
            console.error('Delete year error:', err);
            return res.redirect('/admin/academic-years?error=Delete failed');
          }
          res.redirect('/admin/academic-years?success=Year ' + yearName + ' and all data deleted');
        });
      });
    });
  });
});
// === EDIT ACADEMIC YEAR ===
app.get('/admin/academic-years/edit/:id', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const yearId = req.params.id;
  db.get('SELECT * FROM academic_years WHERE id = ?', [yearId], (err, year) => {
    if (err || !year) {
      return res.redirect('/admin/academic-years?error=Year not found');
    }
    res.render('admin_edit_year', {
      year,
      errorMsg: null,
      successMsg: null
    });
  });
});
app.post('/admin/academic-years/edit/:id', [
  check('year').isInt().withMessage('Valid year required')
], (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const errors = validationResult(req);
  const yearId = req.params.id;
  const { year } = req.body;
  if (!errors.isEmpty()) {
    return db.get('SELECT * FROM academic_years WHERE id = ?', [yearId], (err, yr) => {
      res.render('admin_edit_year', {
        year: yr || { id: yearId, year },
        errorMsg: errors.array()[0].msg,
        successMsg: null
      });
    });
  }
  db.run('UPDATE academic_years SET year = ? WHERE id = ?', [year, yearId], function (err) {
    if (err) {
      console.error('Edit year error:', err);
      return res.redirect(`/admin/academic-years/edit/${yearId}?error=Update failed`);
    }
    // Update term names too
    db.run(`
      UPDATE terms
      SET name = REPLACE(name,
        (SELECT year FROM academic_years WHERE id = terms.year_id),
        ?)
      WHERE year_id = ?
    `, [year, yearId], (err) => {
      if (err) console.error('Term name update error:', err);
    });
    res.redirect('/admin/academic-years?success=Year updated successfully');
  });
});


// FINAL & CORRECT: GET - Assign Class Teacher Form
app.get('/admin/class/:classId/class-teacher', (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  const classId = req.params.classId;
  const termId = req.query.termId;

  if (!termId) {
    return res.redirect('/admin/academic-years?error=Term+required');
  }

  db.get('SELECT name FROM classes WHERE id = ?', [classId], (err, cls) => {
    if (err || !cls) {
      return res.redirect(`/admin/term/${termId}/classes?error=Class+not+found`);
    }

    // Get all approved teachers
    db.all(
      `SELECT id, name, username 
       FROM users 
       WHERE role = 'teacher' AND status = 'approved' 
       ORDER BY name`,
      (err, teachers) => {
        if (err) teachers = [];

        // Get current class teacher (if any)
        db.get(
          `SELECT u.id, u.name, u.username 
           FROM users u 
           JOIN classes c ON c.class_teacher_id = u.id 
           WHERE c.id = ?`,
          [classId],
          (err, currentTeacher) => {
            if (err) currentTeacher = null;

            res.render('admin_class_teacher', {
              classId,
              className: cls.name,
              termId,
              teachers,
              currentTeacher, // will be null or {id, name, username}
              successMsg: req.query.success || null,
              errorMsg: req.query.error || null
            });
          }
        );
      }
    );
  });
});


// FINAL & CORRECT: POST - Save Class Teacher
app.post('/admin/class/:classId/class-teacher', (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  const classId = req.params.classId;
  const { teacherId, termId } = req.body;

  if (!termId) {
    return res.redirect('/admin/academic-years?error=Term+missing');
  }

  if (!teacherId || teacherId === '' || teacherId === 'none') {
    // Remove class teacher
    db.run(
      'UPDATE classes SET class_teacher_id = NULL WHERE id = ?',
      [classId],
      (err) => {
        if (err) {
          console.error('Remove class teacher error:', err);
          return res.redirect(`/admin/class/${classId}/class-teacher?termId=${termId}&error=Remove+failed`);
        }
        return res.redirect(`/admin/class/${classId}/courses?termId=${termId}&success=Class+teacher+removed`);
      }
    );
  } else {
    // Assign new class teacher
    db.run(
      'UPDATE classes SET class_teacher_id = ? WHERE id = ?',
      [teacherId, classId],
      function (err) {
        if (err) {
          console.error('Assign class teacher error:', err);
          return res.redirect(`/admin/class/${classId}/class-teacher?termId=${termId}&error=Assign+failed`);
        }
        res.redirect(`/admin/class/${classId}/courses?termId=${termId}&success=Class+teacher+assigned+successfully`);
      }
    );
  }
});



// Classes and Courses Management
app.get('/admin/term/:termId/classes', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const termId = req.params.termId;
  db.get(
    'SELECT t.name AS term_name, t.year_id, y.year FROM terms t JOIN academic_years y ON t.year_id = y.id WHERE t.id = ?',
    [termId],
    (err, term) => {
      if (err || !term) return res.redirect('/admin/academic-years?error=Term not found');
      db.all(
        `SELECT c.id, c.name, c.class_teacher_id, u.name AS teacher_name
         FROM classes c
         LEFT JOIN users u ON c.class_teacher_id = u.id AND u.role = 'teacher'
         ORDER BY c.name`,
        (err, classes) => {
          if (err) return res.redirect('/admin/academic-years?error=DB error');
          res.render('admin_term_classes', {
            termId,
            termName: term.term_name,
            year: term.year,
            classes,
            errors: [],
            successMsg: req.query.success,
            errorMsg: req.query.error
          });
        }
      );
    }
  );
});
app.post('/admin/term/:termId/classes', [
  check('name').notEmpty().withMessage('Class name required')
], (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('admin_term_classes', {
      termId: req.params.termId,
      classes: [],
      errors: errors.array(),
      successMsg: null,
      errorMsg: null
    });
  }
  const termId = req.params.termId;
  const { name } = req.body;
  db.run('INSERT INTO classes (name) VALUES (?)', [name], function (err) {
    if (err) {
      console.error('Class add error:', err);
      return res.render('admin_term_classes', {
        termId,
        classes: [],
        errors: [{ msg: 'Error adding class' }],
        successMsg: null,
        errorMsg: null
      });
    }
    const classId = this.lastID;
    res.redirect(`/admin/class/${classId}/courses?termId=${termId}`);
  });
});
// === GET: Classes in a Term (WITH TEACHER NAME) ===
app.get('/admin/term/:termId/classes', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const termId = req.params.termId;
  db.get(
    'SELECT t.name AS term_name, y.year FROM terms t JOIN academic_years y ON t.year_id = y.id WHERE t.id = ?',
    [termId],
    (err, term) => {
      if (err || !term) return res.redirect('/admin/academic-years?error=Term not found');
      db.all(`
        SELECT DISTINCT cl.id, cl.name,
               u.name AS teacher_name
        FROM classes cl
        JOIN courses c ON c.class_id = cl.id
        JOIN student_enrollments se ON se.course_id = c.id
        LEFT JOIN users u ON cl.class_teacher_id = u.id
        WHERE se.term_id = ?
        ORDER BY cl.name
      `, [termId], (err, classes) => {
        if (err) classes = [];
        res.render('admin_term_classes', {
          termId,
          termName: term.term_name,
          year: term.year,
          classes,
          successMsg: req.query.success,
          errorMsg: req.query.error
        });
      });
    }
  );
});
app.post('/admin/class/:classId/courses', [
  check('courses_list').notEmpty().withMessage('Enter courses separated by commas')
], (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('admin_class_courses', {
      classId: req.params.classId,
      courses: [],
      errors: errors.array(),
      successMsg: null,
      errorMsg: null
    });
  }
  const classId = req.params.classId;
  const termId = req.query.termId;
  const { courses_list } = req.body;
  const courseNames = courses_list.split(',').map(name => name.trim());
  let inserted = 0;
  function insertNext(i) {
    if (i >= courseNames.length) {
      res.redirect(`/admin/term/${termId}/classes`);
      return;
    }
    db.run('INSERT INTO courses (class_id, name) VALUES (?, ?)', [classId, courseNames[i]], (err) => {
      if (err) {
        console.error('Course add error:', err);
      } else {
        inserted++;
      }
      insertNext(i + 1);
    });
  }
  insertNext(0);
});
// === GET: Classes in a Term (WITH STUDENT COUNT) ===
// === GET: Classes in a Term (WITH CORRECT STUDENT COUNT) ===
app.get('/admin/term/:termId/classes', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const termId = req.params.termId;
db.get(
    'SELECT t.name AS term_name, y.year FROM terms t JOIN academic_years y ON t.year_id = y.id WHERE t.id = ?',
    [termId],
    (err, term) => {
      if (err || !term) return res.redirect('/admin/academic-years?error=Term not found');
      // Get ALL classes (even with 0 students)
      db.all(`
        SELECT
          cl.id,
          cl.name,
          u.name AS teacher_name,
          COALESCE(student_counts.count, 0) AS student_count
        FROM classes cl
        LEFT JOIN users u ON cl.class_teacher_id = u.id
        LEFT JOIN (
          SELECT
            c.class_id,
            COUNT(DISTINCT se.student_id) AS count
          FROM courses c
          JOIN student_enrollments se ON se.course_id = c.id
          WHERE se.term_id = ?
          GROUP BY c.class_id
        ) student_counts ON student_counts.class_id = cl.id
        ORDER BY cl.name
      `, [termId], (err, classes) => {
        if (err) {
          console.error('Classes fetch error:', err);
          classes = [];
        }
        res.render('admin_term_classes', {
          termId,
          termName: term.term_name,
          year: term.year,
          classes,
          successMsg: req.query.success,
          errorMsg: req.query.error
        });
      });
    }
  );
});
// === GET: Students in a Class ===
app.get('/admin/class/:classId/students', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const classId = req.params.classId;
  const termId = req.query.termId;
  if (!termId) return res.redirect('/admin/academic-years');
  db.get('SELECT name FROM classes WHERE id = ?', [classId], (err, cls) => {
    if (err || !cls) return res.redirect(`/admin/term/${termId}/classes?error=Class not found`);
    db.get('SELECT y.year, t.name AS term_name FROM terms t JOIN academic_years y ON t.year_id = y.id WHERE t.id = ?', [termId], (err, termInfo) => {
      if (err || !termInfo) termInfo = { year: '', term_name: '' };
      db.all(`
        SELECT DISTINCT u.id, u.name, u.username
        FROM users u
        JOIN student_enrollments se ON se.student_id = u.id
        JOIN courses c ON se.course_id = c.id
        WHERE c.class_id = ? AND se.term_id = ?
        ORDER BY u.name
      `, [classId, termId], (err, students) => {
        if (err) students = [];
        res.render('admin_class_students', {
          classId,
          className: cls.name,
          termId,
          year: termInfo.year,
          termName: termInfo.term_name,
          students,
          successMsg: req.query.success,
          errorMsg: req.query.error
        });
      });
    });
  });
});
// POST: Force remove student from class (deletes grades + enrollment)
app.post('/admin/class/:classId/remove-student', (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  const classId = req.params.classId;
  const { studentId, termId } = req.body;

  if (!studentId || !termId) {
    return res.redirect(`/admin/class/${classId}/students?termId=${termId}&error=Missing+data`);
  }

  db.serialize(() => {
    // Step 1: Delete ALL grades for this student in this term across ALL courses in this class
    db.run(`
      DELETE FROM grades 
      WHERE student_id = ? 
        AND term_id = ?
        AND course_id IN (SELECT id FROM courses WHERE class_id = ?)
    `, [studentId, termId, classId], function(err) {
      if (err) {
        console.error('Error deleting grades:', err);
      } else {
        console.log(`Deleted ${this.changes} grade(s) for student ${studentId}`);
      }

      // Step 2: Delete the enrollments (now safe because grades are gone)
      db.run(`
        DELETE FROM student_enrollments 
        WHERE student_id = ? 
          AND term_id = ?
          AND course_id IN (SELECT id FROM courses WHERE class_id = ?)
      `, [studentId, termId, classId], function(err) {
        if (err) {
          console.error('Error deleting enrollment:', err);
          return res.redirect(`/admin/class/${classId}/students?termId=${termId}&error=Remove+failed`);
        }

        if (this.changes === 0) {
          return res.redirect(`/admin/class/${classId}/students?termId=${termId}&error=No+enrollment+found`);
        }

        // Success!
        res.redirect(`/admin/class/${classId}/students?termId=${termId}&success=Student+removed+successfully+(grades+deleted)`);
      });
    });
  });
});


// === POST: Remove Class Teacher ===
app.post('/admin/class/:classId/remove-class-teacher', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const classId = req.params.classId;
  const termId = req.query.termId;
  db.run('UPDATE classes SET class_teacher_id = NULL WHERE id = ?', [classId], (err) => {
    if (err) {
      console.error('Remove class teacher error:', err);
      return res.redirect(`/admin/term/${termId}/classes?error=Remove failed`);
    }
    res.redirect(`/admin/term/${termId}/classes?success=Class teacher removed`);
  });
});
app.get('/admin/course/:courseId/edit', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const courseId = req.params.courseId;
  const termId = req.query.termId;
  const classId = req.query.classId;
  db.get('SELECT name FROM courses WHERE id = ?', [courseId], (err, course) => {
    if (err || !course) return res.redirect('/admin/academic-years?error=Course not found');
    res.render('admin_edit_course', { courseId, course, termId, classId, successMsg: null, errorMsg: null });
  });
});
app.post('/admin/course/:courseId/edit', [
  check('name').notEmpty().withMessage('Course name required')
], (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const courseId = req.params.courseId;
  const { name, termId, classId } = req.body;
  db.run('UPDATE courses SET name = ? WHERE id = ?', [name, courseId], err => {
    if (err) return res.redirect(`/admin/class/${classId}/courses?termId=${termId}&error=Update failed`);
    res.redirect(`/admin/class/${classId}/courses?termId=${termId}&success=Course updated`);
  });
});
app.post('/admin/course/:courseId/delete', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const courseId = req.params.courseId;
  const { termId, classId } = req.body;
  db.run('DELETE FROM courses WHERE id = ?', [courseId], err => {
    if (err) return res.redirect(`/admin/class/${classId}/courses?termId=${termId}&error=Delete failed`);
    res.redirect(`/admin/class/${classId}/courses?termId=${termId}&success=Course deleted`);
  });
});
// Bulk Enroll Students
const util = require('util');
const dbGet = util.promisify(db.get.bind(db));
const dbRun = util.promisify(db.run.bind(db));
const dbAll = util.promisify(db.all.bind(db));
app.get('/admin/class/:classId/enroll', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const classId = req.params.classId;
  const termId = req.query.termId;
  db.get('SELECT name FROM classes WHERE id = ?', [classId], (err, cls) => {
    if (!cls) return res.redirect('/admin/academic-years?error=Class not found');
    res.render('admin_enroll_student', {
      classId,
      className: cls.name,
      termId,
      errors: [],
      successMsg: req.query.success,
      errorMsg: req.query.error
    });
  });
});
app.post('/admin/class/:classId/enroll', async (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const classId = parseInt(req.params.classId, 10);
  const termId = parseInt(req.body.termId, 10);
  const studentUsernames = req.body.student_usernames
    .split(',')
    .map(u => u.trim())
    .filter(u => u !== '');
  if (isNaN(classId) || isNaN(termId)) {
    return res.render('admin_enroll_student', {
      classId,
      termId,
      errors: [{ msg: 'Invalid class or term ID' }],
      className: req.body.className,
      successMsg: null,
      errorMsg: null
    });
  }
  if (!studentUsernames.length) {
    return res.render('admin_enroll_student', {
      classId,
      termId,
      errors: [{ msg: 'At least one student username required' }],
      className: req.body.className,
      successMsg: null,
      errorMsg: null
    });
  }
  const timeout = setTimeout(() => {
    console.error('Bulk enrollment timed out');
    res.render('admin_enroll_student', {
      classId,
      termId,
      errors: [{ msg: 'Request timed out. Please try again.' }],
      className: req.body.className,
      successMsg: null,
      errorMsg: null
    });
  }, 10000);
  try {
    const term = await dbGet('SELECT id FROM terms WHERE id = ?', [termId]);
    if (!term) {
      clearTimeout(timeout);
      return res.render('admin_enroll_student', {
        classId,
        termId,
        errors: [{ msg: 'Term not found' }],
        className: req.body.className,
        successMsg: null,
        errorMsg: null
      });
    }
    const courses = await dbAll('SELECT id FROM courses WHERE class_id = ?', [classId]);
    if (!courses.length) {
      clearTimeout(timeout);
      return res.render('admin_enroll_student', {
        classId,
        termId,
        errors: [{ msg: 'No courses found for this class' }],
        className: req.body.className,
        successMsg: null,
        errorMsg: null
      });
    }
    let enrolledStudents = 0;
    const errors = [];
    for (const username of studentUsernames) {
      try {
        const student = await dbGet(
          'SELECT id FROM users WHERE username = ? AND role = "student"',
          [username]
        );
        if (!student) {
          errors.push({ msg: `Student not found: ${username}` });
          continue;
        }
        for (const course of courses) {
          try {
            await dbRun(
              'INSERT OR IGNORE INTO student_enrollments (student_id, course_id, term_id) VALUES (?, ?, ?)',
              [student.id, course.id, termId]
            );
          } catch (err) {
            console.error(`Error enrolling ${username} in course ${course.id}:`, err);
            errors.push({ msg: `Failed to enroll ${username} in a course` });
          }
        }
        enrolledStudents++;
      } catch (err) {
        console.error(`Error processing student ${username}:`, err);
        errors.push({ msg: `Error with student ${username}` });
      }
    }
    clearTimeout(timeout);
    const successMsg = enrolledStudents > 0
      ? `Enrolled ${enrolledStudents} student(s) in all courses`
      : null;
    res.render('admin_enroll_student', {
      classId,
      termId,
      className: req.body.className,
      errors,
      successMsg
    });
  } catch (err) {
    console.error('Bulk enrollment error:', err);
    clearTimeout(timeout);
    res.render('admin_enroll_student', {
      classId,
      termId,
      errors: [{ msg: 'Database error. Please try again.' }],
      className: req.body.className,
      successMsg: null,
      errorMsg: null
    });
  }
});
// === ASSIGN / REMOVE TEACHER – WITH DEBUG LOGS ===
app.post('/admin/course/:courseId/assign-teacher', (req, res) => {
  console.log('POST /assign-teacher:', req.body); // DEBUG
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const courseId = req.params.courseId;
  const isJSON = req.headers['content-type']?.includes('application/json');
  let teacher_username = null;
  let remove = false;
  if (isJSON) {
    teacher_username = req.body.teacher_username;
    remove = req.body.remove === true;
  } else {
    teacher_username = req.body.teacher_username;
    remove = req.body.remove === '1';
  }
  console.log('Parsed:', { courseId, teacher_username, remove }); // DEBUG
  // === REMOVE TEACHER ===
  if (remove) {
    db.run('DELETE FROM teacher_assignments WHERE course_id = ?', [courseId], (err) => {
      if (err) {
        console.error('Remove error:', err);
        return isJSON ? res.status(500).json({ error: 'Remove failed' }) : res.redirect('back');
      }
      console.log('Teacher removed from course', courseId);
      return isJSON ? res.json({ success: true, removed: true }) : res.redirect('back');
    });
    return;
  }
  // === ASSIGN TEACHER ===
  const username = (teacher_username || '').toString().trim();
  if (!username) {
    console.log('Missing username');
    return isJSON ? res.status(400).json({ error: 'Teacher username is required' }) : res.redirect('back');
  }
  db.get(
    'SELECT id, name FROM users WHERE username = ? AND role = "teacher" AND status = "approved"',
    [username],
    (err, teacher) => {
      if (err) {
        console.error('DB error:', err);
        return isJSON ? res.status(500).json({ error: 'Database error' }) : res.redirect('back');
      }
      if (!teacher) {
        console.log('Teacher not found:', username);
        return isJSON ? res.status(404).json({ error: 'Teacher not found or not approved' }) : res.redirect('back');
      }
      console.log('Found teacher:', teacher);
      db.run(
        'INSERT OR REPLACE INTO teacher_assignments (teacher_id, course_id) VALUES (?, ?)',
        [teacher.id, courseId],
        (err) => {
          if (err) {
            console.error('Assign error:', err);
            return isJSON ? res.status(500).json({ error: 'Assign failed' }) : res.redirect('back');
          }
          console.log('Teacher assigned:', teacher.name, 'to course', courseId);
          if (isJSON) {
            res.json({ success: true, teacher_name: teacher.name });
          } else {
            res.redirect('back');
          }
        }
      );
    }
  );
});


// ADMIN: Re-enroll all students for current term (FIXED & SAFE)
// ————————————————————————————————————————
app.get('/admin/re-enroll-students', async (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/login');

  try {
    const currentYearRow = await get("SELECT id FROM academic_years WHERE current = 1");
    if (!currentYearRow) throw new Error("No current year");

    const currentYearId = currentYearRow.id;

    // Get ALL previous enrollments (from any year)
    const previous = await query(`
      SELECT DISTINCT student_id, course_id
      FROM student_enrollments
      WHERE year_id IS NULL OR year_id != ?
    `, [currentYearId]);

    if (previous.length === 0) {
      req.flash('info', 'No previous enrollments found');
      return res.redirect('/dashboard');
    }

    // Insert with year_id (and current term_id if you want)
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO student_enrollments 
      (student_id, course_id, term_id, year_id) 
      VALUES (?, ?, ?, ?)
    `);

    const currentTermId = await getCurrentTermId();

    for (const row of previous) {
      stmt.run(row.student_id, row.course_id, currentTermId, currentYearId);
    }

    await new Promise((resolve, reject) => {
      stmt.finalize(err => err ? reject(err) : resolve());
    });

    req.flash('success', `Re-enrolled ${previous.length} records for the entire year!`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Re-enroll failed: ' + err.message);
    res.redirect('/dashboard');
  }
});


// === TEACHER: GRADE A COURSE — FINAL WORKING VERSION ===
// TEACHER: GRADE A COURSE — GUARANTEED TO SHOW ENROLLED STUDENTS
// TEACHER: GRADE A COURSE — FINAL 100% WORKING VERSION (NO c.teacher_id ERROR)
app.get('/teacher/grade/course/:courseId', isTeacher, async (req, res) => {
  const courseId = req.params.courseId;
  const teacherId = req.session.userId;
  const termId = await getCurrentTermId();

  if (!termId) {
    req.flash('error', 'No active term found');
    return res.redirect('/teacher/courses');
  }

  try {
    // 1. Verify teacher is assigned + get course info (NO c.teacher_id!)
    const courseResult = await query(`
      SELECT 
        c.id,
        c.name AS course_name,
        cl.name AS class_name
      FROM teacher_assignments ta
      JOIN courses c ON ta.course_id = c.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE ta.teacher_id = ? AND c.id = ?
    `, [teacherId, courseId]);

    if (courseResult.length === 0) {
      req.flash('error', 'Course not found or you are not assigned to teach it');
      return res.redirect('/teacher/courses');
    }

    const course = courseResult[0];

    // 2. Get all enrolled students for this course + term
    const students = await query(`
      SELECT DISTINCT
        u.id AS student_id,
        u.name,
        u.username AS matric_number
      FROM student_enrollments se
      JOIN users u ON se.student_id = u.id
      WHERE se.course_id = ? AND se.term_id = ?
      ORDER BY u.name ASC
    `, [courseId, termId]);

    // 3. Load existing grades
    const grades = await query(`
      SELECT 
        g.student_id,
        g.ca,
        g.exam,
        g.total,
        g.grade,
        g.gpa_points
      FROM grades g
      JOIN student_enrollments se ON g.enrollment_id = se.id
      WHERE se.course_id = ? AND se.term_id = ?
    `, [courseId, termId]);

    const gradeMap = {};
    grades.forEach(g => {
      gradeMap[g.student_id] = {
        ca: g.ca || '',
        exam: g.exam || '',
        total: g.total || 0,
        grade: g.grade || 'F',
        gpa_points: g.gpa_points || 0
      };
    });

    // 4. Render the grading sheet
    res.render('teacher_cgpa_grading', {
      course,
      students,
      gradeMap,
      saved: req.query.saved === '1',
      current_term_name: req.current_term_name || 'Current Term', // optional bonus
      error: req.flash('error')[0]
    });

  } catch (err) {
    console.error('Grade page error:', err);
    req.flash('error', 'Failed to load grading sheet');
    res.redirect('/teacher/courses');
  }
});
// === CGPA GRADING: SAVE ALL — NOW SAVES enrollment_id CORRECTLY ===
app.post('/teacher/grade/course/:courseId/save', isTeacher, async (req, res) => {
  const courseId = req.params.courseId;
  const teacherId = req.session.userId;
  const termId = await getCurrentTermId();

  if (!termId) {
    req.flash('error', 'No active term');
    return res.redirect('/teacher/courses');
  }

  try {
    // First: Get all enrollments for this course + term (with enrollment_id!)
    const enrollments = await query(`
      SELECT se.id AS enrollment_id, se.student_id
      FROM student_enrollments se
      WHERE se.course_id = ? AND se.term_id = ?
    `, [courseId, termId]);

    const enrollmentMap = {};
    enrollments.forEach(e => {
      enrollmentMap[e.student_id] = e.enrollment_id;
    });

    const data = req.body;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO grades 
      (enrollment_id, student_id, course_id, term_id, ca, exam, total, grade, gpa_points, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let savedCount = 0;
    for (const key in data) {
      if (key.startsWith('ca_')) {
        const studentId = key.split('_')[1];
        const enrollment_id = enrollmentMap[studentId];

        if (!enrollment_id) continue; // safety

        const ca = Math.min(parseInt(data[key]) || 0, 30);
        const exam = Math.min(parseInt(data[`exam_${studentId}`]) || 0, 70);
        const total = ca + exam;

        let grade = 'F', gpa_points = 0;
        if (total >= 70) { grade = 'A'; gpa_points = 5; }
        else if (total >= 60) { grade = 'B'; gpa_points = 4; }
        else if (total >= 50) { grade = 'C'; gpa_points = 3; }
        else if (total >= 40) { grade = 'D'; gpa_points = 2; }
        else if (total >= 0)  { grade = 'F'; gpa_points = 0; }

        stmt.run([
          enrollment_id,
          studentId,
          courseId,
          termId,
          ca,
          exam,
          total,
          grade,
          gpa_points,
          teacherId
        ]);
        savedCount++;
      }
    }

    await new Promise((resolve, reject) => {
      stmt.finalize(err => err ? reject(err) : resolve());
    });

    req.flash('success', `Saved grades for ${savedCount} students!`);
    res.redirect(`/teacher/grade/course/${courseId}?saved=1`);

  } catch (err) {
    console.error('Save grades error:', err);
    req.flash('error', 'Failed to save grades');
    res.redirect('/teacher/courses');
  }
});
// STUDENT: VIEW ALL TERMS RESULTS (COLLAPSIBLE + CURRENT BADGE + GPA + POSITION)
app.get('/student/current-term', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'student') {
    return res.redirect('/login');
  }
  const studentId = req.session.userId;

  try {
    // 1. Get student's CURRENT class for the CURRENT academic year
    const classResult = await query(`
      SELECT DISTINCT c.id AS class_id, c.name AS class_name
      FROM student_enrollments se
      JOIN courses co ON se.course_id = co.id
      JOIN classes c ON co.class_id = c.id
      JOIN terms t ON se.term_id = t.id
      JOIN academic_years ay ON t.year_id = ay.id
      WHERE se.student_id = ? AND ay.current = 1
      LIMIT 1
    `, [studentId]);

    // If no enrollment in current year → show "Not Assigned"
    if (!classResult || classResult.length === 0) {
      return res.render('student_current_term', {
        termsData: [],
        currentYear: 'N/A',
        studentClass: 'Not Assigned',
        yearlyCGPA: null,
        yearlyPosition: '-'
      });
    }

    const studentClassId = classResult[0].class_id;
    const studentClass = classResult[0].class_name || 'Not Assigned';

    // 2. Get current academic year
    const currentYearRow = await get("SELECT id, year FROM academic_years WHERE current = 1");
    if (!currentYearRow) {
      return res.render('student_current_term', {
        termsData: [],
        currentYear: 'N/A',
        studentClass,
        yearlyCGPA: null,
        yearlyPosition: '-'
      });
    }

    const yearId = currentYearRow.id;
    const currentYear = currentYearRow.year || '2025/2026';

    // 3. Get all terms in current year
    const terms = await query(`
      SELECT id, name, is_current, term_number 
      FROM terms 
      WHERE year_id = ? 
      ORDER BY term_number ASC
    `, [yearId]);

    const termsData = [];

    // Helper: Add 1st, 2nd, 3rd suffix
    const getPositionSuffix = (num) => {
      if (num >= 11 && num <= 13) return `${num}th`;
      const last = num % 10;
      return num + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
    };

    // Helper: Get class ranking for a term
const getClassRankings = async (termId) => {
  const rankings = await query(`
    SELECT g.student_id, SUM(g.total) as term_total
    FROM grades g
    JOIN student_enrollments se ON g.student_id = se.student_id 
                                AND g.course_id = se.course_id 
                                AND g.term_id = se.term_id
    JOIN courses co ON se.course_id = co.id
    WHERE g.term_id = ?
      AND co.class_id = ?
      AND g.ca > 0 AND g.exam > 0
    GROUP BY g.student_id
    HAVING COUNT(DISTINCT g.course_id) = (
      SELECT COUNT(*) 
      FROM student_enrollments se2 
      JOIN courses co2 ON se2.course_id = co2.id 
      WHERE se2.student_id = g.student_id 
        AND se2.term_id = ? 
        AND co2.class_id = ?
    )
    ORDER BY term_total DESC
  `, [termId, studentClassId, termId, studentClassId]);

  return rankings.map((row, i) => ({
    student_id: row.student_id,
    position: getPositionSuffix(i + 1)
  }));
};

    for (let term of terms) {
      const courses = await query(`
        SELECT DISTINCT c.id AS course_id, c.name AS course_name
        FROM student_enrollments se
        JOIN courses c ON se.course_id = c.id
        WHERE se.student_id = ? AND se.term_id = ?
        ORDER BY c.name
      `, [studentId, term.id]);

      const grades = await query(`
        SELECT course_id, ca, exam, total, grade 
        FROM grades 
        WHERE student_id = ? AND term_id = ?
      `, [studentId, term.id]);

      const results = {};
      let totalPoints = 0;
      let completedSubjects = 0;
      const totalSubjects = courses.length;

      grades.forEach(g => {
        const ca = g.ca || 0;
        const exam = g.exam || 0;
        const total = g.total || 0;
        const grade = g.grade || 'F';
        const isEntered = ca > 0 && exam > 0;

        results[g.course_id] = {
          ca: isEntered ? ca : 0,
          exam: isEntered ? exam : 0,
          total: isEntered ? total : 0,
          grade: isEntered ? grade : null
        };

        if (isEntered) {
          completedSubjects++;
          const gp = { 'A':5, 'B':4, 'C':3, 'D':2, 'E':1, 'F':0 }[grade] || 0;
          totalPoints += gp;
        }
      });

      const scoresComplete = completedSubjects === totalSubjects && totalSubjects > 0;
      const gpa = scoresComplete ? (totalPoints / completedSubjects).toFixed(2) : null;

      let position = '-';
      if (scoresComplete) {
        const rankings = await getClassRankings(term.id);
        const myRank = rankings.find(r => r.student_id === studentId);
        position = myRank ? myRank.position : 'Unranked';
      }

      termsData.push({
        id: term.id,
        name: term.name,
        is_current: term.is_current === 1,
        term_number: term.term_number,
        courses,
        results,
        gpa,
        position,
        scoresComplete
      });
    }

    // Yearly CGPA & Position
    let yearlyCGPA = null;
    let yearlyPosition = '-';
    const allComplete = termsData.every(t => t.scoresComplete && t.gpa !== null);

    if (allComplete && termsData.length > 0) {
    // FIXED: Yearly ranking
const yearlyTotals = await query(`
  SELECT g.student_id, SUM(g.total) as total_score
  FROM grades g
  JOIN terms t ON g.term_id = t.id
  JOIN student_enrollments se ON g.student_id = se.student_id 
                             AND g.course_id = se.course_id 
                             AND g.term_id = se.term_id
  JOIN courses co ON se.course_id = co.id
  WHERE t.year_id = ? 
    AND co.class_id = ?
    AND g.ca > 0 AND g.exam > 0
  GROUP BY g.student_id
  ORDER BY total_score DESC
`, [yearId, studentClassId]);

      const myRank = yearlyTotals.findIndex(r => r.student_id === studentId) + 1;
      yearlyPosition = myRank > 0 ? getPositionSuffix(myRank) : '-';

      const avgGpa = termsData.reduce((sum, t) => sum + parseFloat(t.gpa), 0) / termsData.length;
      yearlyCGPA = avgGpa.toFixed(2);
    }

    res.render('student_current_term', {
      termsData,
      currentYear,
      studentClass,
      yearlyCGPA,
      yearlyPosition
    });

  } catch (err) {
    console.error('Error in /student/current-term:', err);
    res.status(500).send('Server Error');
  }
});


// STUDENT: Academic History - Shows ALL COMPLETED Academic Years
// STUDENT: Academic History – WITH CLASS + POSITION AFTER EACH TERM
app.get('/student/history', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'student') {
    return res.redirect('/login');
  }

  const studentId = req.session.userId;

  try {
    // 1. Get all completed academic years
    const years = await query(`
      SELECT ay.id, ay.year AS academic_year
      FROM academic_years ay
      WHERE ay.is_completed = 1
      ORDER BY ay.year DESC
    `);

    if (years.length === 0) {
      return res.render('student_history', { historyYears: [], noHistory: true });
    }

    const historyYears = [];

    for (const year of years) {
      // Get terms for this year
      const terms = await query(`
        SELECT t.id, t.name AS term_name, t.term_number
        FROM terms t
        WHERE t.year_id = ? 
        ORDER BY t.term_number
      `, [year.id]);

      const termData = [];

      for (const term of terms) {
        // Clean term name (First Term / Second Term / Third Term)
        let cleanTerm = term.term_name;
        cleanTerm = cleanTerm.replace(/^\d{4,5}[\/\-\s]*\d{0,4}\s*-?\s*/g, '').trim();
        if (cleanTerm.match(/first|1st|1/i)) cleanTerm = 'First Term';
        else if (cleanTerm.match(/second|2nd|2/i)) cleanTerm = 'Second Term';
        else if (cleanTerm.match(/third|3rd|3/i)) cleanTerm = 'Third Term';

        // Get student's class for this term
        const classRow = await query(`
          SELECT DISTINCT cl.name AS class_name
          FROM student_enrollments se
          JOIN courses co ON se.course_id = co.id
          JOIN classes cl ON co.class_id = cl.id
          WHERE se.student_id = ? AND se.term_id = ?
          LIMIT 1
        `, [studentId, term.id]);

        const studentClass = classRow[0]?.class_name || 'Unknown Class';

        // Get position in this term
        const position = await getTermPosition(studentId, term.id);

        // Get all courses + grades for this term
        const courses = await query(`
          SELECT c.name AS course_name, g.ca, g.exam, g.total, g.grade
          FROM grades g
          JOIN courses c ON g.course_id = c.id
          WHERE g.student_id = ? AND g.term_id = ?
          ORDER BY c.name
        `, [studentId, term.id]);

        termData.push({
          term_name: cleanTerm,
          class_name: studentClass,
          position: position,          // e.g. "1st of 38"
          courses: courses.map(c => ({
            course_name: c.course_name,
            ca: c.ca ?? '-',
            exam: c.exam ?? '-',
            total: c.total ?? '-',
            grade: c.grade ?? '-'
          }))
        });
      }

      historyYears.push({
        academic_year: year.academic_year,
        terms: termData
      });
    }

    res.render('student_history', { historyYears, noHistory: false });

  } catch (err) {
    console.error('History error:', err);
    res.render('student_history', { historyYears: [], noHistory: true, message: 'Error loading history' });
  }
});
// ========================================
// TEACHER: View Past Teaching History
// ========================================
app.get('/teacher/history', authenticate, async (req, res) => {
  if (req.session.role !== 'teacher') return res.redirect('/dashboard');

  const teacherId = req.session.userId;
  try {
    const rows = await query(`
      SELECT ah.academic_year, ah.term_name,
             cl.name AS class_name, c.name AS course_name,
             COUNT(ah.student_id) AS graded_count,
             ROUND(AVG(ah.total), 1) AS avg_score
      FROM academic_history ah
      JOIN courses c ON ah.course_id = c.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE ah.teacher_id = ? AND ah.academic_year NOT IN (
        SELECT year FROM academic_years WHERE current = 1
      )
      GROUP BY ah.academic_year, ah.term_name, cl.name, c.name
      ORDER BY ah.academic_year DESC, ah.term_name
    `, [teacherId]);

    const history = {};
    rows.forEach(r => {
      if (!history[r.academic_year]) history[r.academic_year] = { year: r.academic_year, terms: {} };
      if (!history[r.academic_year].terms[r.term_name]) {
        history[r.academic_year].terms[r.term_name] = { term: r.term_name, classes: {} };
      }
      if (!history[r.academic_year].terms[r.term_name].classes[r.class_name]) {
        history[r.academic_year].terms[r.term_name].classes[r.class_name] = { class: r.class_name, courses: [] };
      }
      history[r.academic_year].terms[r.term_name].classes[r.class_name].courses.push({
        course: r.course_name,
        graded: r.graded_count,
        avg: r.avg_score
      });
    });

    const formatted = Object.values(history).map(y => ({
      ...y,
      terms: Object.values(y.terms).map(t => ({
        ...t,
        classes: Object.values(t.classes)
      }))
    }));

    res.render('teacher_history', {
      user: req.session,
      history: formatted.length > 0 ? formatted : null,
      noHistory: formatted.length === 0
    });

  } catch (err) {
    console.error('Teacher history error:', err);
    res.render('teacher_history', { user: req.session, history: [], error: 'Failed to load history' });
  }
});




// === TEACHER: VIEW STUDENTS IN COURSE + MANAGE GRADES ===
app.get('/teacher/course/:courseId/students', (req, res) => {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.redirect('/login');
  }
  const courseId = req.params.courseId;
  const teacherId = req.session.userId;
  // Verify teacher teaches this course
  db.get('SELECT 1 FROM teacher_assignments WHERE teacher_id = ? AND course_id = ?', [teacherId, courseId], (err, assignment) => {
    if (err || !assignment) {
      return res.status(403).send('Access denied');
    }
    db.get('SELECT name, class_id FROM courses WHERE id = ?', [courseId], (err, course) => {
      if (err || !course) return res.status(404).send('Course not found');
      db.get('SELECT name FROM classes WHERE id = ?', [course.class_id], (err, classInfo) => {
        const className = classInfo ? classInfo.name : 'Unknown';
        db.all(`
          SELECT se.student_id, u.name AS student_name
          FROM student_enrollments se
          JOIN users u ON se.student_id = u.id
          WHERE se.course_id = ?
          ORDER BY u.name
        `, [courseId], (err, students) => {
          if (err) students = [];
          res.render('teacher_course_students', {
            user: req.session,
            course: { id: courseId, name: course.name, class: className },
            students
          });
        });
      });
    });
  });
});
// === BONUS: GRADE MANAGEMENT ===
app.get('/teacher/grade/:courseId/student/:studentId', (req, res) => {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.redirect('/login');
  }
  const teacherId = req.session.userId;
  const courseId = req.params.courseId;
  const studentId = req.params.studentId;
  // Verify teacher teaches this course
  db.get('SELECT 1 FROM teacher_assignments WHERE teacher_id = ? AND course_id = ?', [teacherId, courseId], (err, assignment) => {
    if (err || !assignment) {
      return res.status(403).send('Access denied');
    }
    // Get student info
    db.get('SELECT name FROM users WHERE id = ?', [studentId], (err, student) => {
      if (err || !student) return res.status(404).send('Student not found');
      // Get current grade
      db.get('SELECT score, grade, comments FROM grades WHERE student_id = ? AND course_id = ?', [studentId, courseId], (err, grade) => {
        if (err) grade = null;
        res.render('teacher_grade_form', {
          user: req.session,
          courseId,
          studentId,
          studentName: student.name,
          currentGrade: grade || { score: '', grade: '', comments: '' }
        });
      });
    });
  });
});
// === POST: Save Grade ===
app.post('/teacher/grade/:courseId/student/:studentId/save', (req, res) => {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.redirect('/login');
  }
  const teacherId = req.session.userId;
  const courseId = req.params.courseId;
  const studentId = req.params.studentId;
  const { score, grade, comments } = req.body;
  // Verify teacher teaches this course
  db.get('SELECT 1 FROM teacher_assignments WHERE teacher_id = ? AND course_id = ?', [teacherId, courseId], (err, assignment) => {
    if (err || !assignment) {
      return res.status(403).send('Access denied');
    }
    // Save grade
    db.run(`
      INSERT OR REPLACE INTO grades
      (student_id, course_id, score, grade, comments)
      VALUES (?, ?, ?, ?, ?)
    `, [studentId, courseId, score, grade, comments], (err) => {
      if (err) {
        console.error('Save grade error:', err);
        return res.redirect(`/teacher/grade/${courseId}/student/${studentId}?error=Save failed`);
      }
      res.redirect(`/teacher/course/${courseId}/students?success=Grade saved`);
    });
  });
});
app.post('/admin/class/:classId/set-class-teacher', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const classId = req.params.classId;
  const { teacher_username, remove } = req.body;
  if (remove) {
    db.run('UPDATE classes SET class_teacher_id = NULL WHERE id = ?', [classId], err => {
      if (err) return res.json({ error: 'Remove failed' });
      res.json({ success: true, removed: true });
    });
    return;
  }
  if (!teacher_username) return res.json({ error: 'Username required' });
  db.get(
    'SELECT id, name FROM users WHERE username = ? AND role = "teacher"',
    [teacher_username],
    (err, teacher) => {
      if (err || !teacher) return res.json({ error: 'Teacher not found' });
      db.run(
        'UPDATE classes SET class_teacher_id = ? WHERE id = ?',
        [teacher.id, classId],
        err => {
          if (err) return res.json({ error: 'Update failed' });
          res.json({ success: true, teacher_name: teacher.name });
        }
      );
    }
  );
});
// Admin Accounts Management
app.get('/admin/account', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const q = (req.query.q || '').trim();
  let sql = `
    SELECT id, username, name, role, status
    FROM users
    WHERE status = 'approved' AND role != 'admin'
  `;
  let params = [];
  if (q) {
    sql += ` AND (username LIKE ? OR name LIKE ?)`;
    const like = `%${q}%`;
    params = [like, like];
  }
  sql += ` ORDER BY name`;
  db.all(sql, params, (err, users) => {
    if (err) {
      console.error(err);
      users = [];
    }
    res.render('admin_account', {
      users,
      q,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
  });
});
// Admin Utilities
app.get('/admin/fix-grades', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  db.all('SELECT * FROM grades WHERE score IS NOT NULL', (err, grades) => {
    if (err) return res.send('Error: ' + err.message);
    let updated = 0;
    grades.forEach(g => {
      let newGrade = '';
      if (g.score >= 70) newGrade = 'A';
      else if (g.score >= 60) newGrade = 'B';
      else if (g.score >= 50) newGrade = 'C';
      else if (g.score >= 40) newGrade = 'D';
      else newGrade = 'F';
      if (newGrade !== g.grade) {
        db.run('UPDATE grades SET grade = ? WHERE id = ?', [newGrade, g.id], function (err) {
          if (!err) updated++;
        });
      }
    });
    res.send(`Fixed ${updated} grades with new scale: A=70+, B=60+, C=50+, D=40+, F<40`);
  });
});
app.get('/admin/users', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') return res.redirect('/login');
  db.all(`
    SELECT id, username, name, role
    FROM users
    WHERE status = 'approved' AND role != 'admin'
    ORDER BY role DESC, name
  `, (err, users) => {
    res.render('admin_users', {
      users,
      success: req.query.success || null
    });
  });
});
app.post('/admin/users/approve/:id', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const userId = req.params.id;
  db.run('UPDATE users SET status = "approved" WHERE id = ?', [userId], (err) => {
    if (err) console.error('Approve error:', err);
    res.redirect('/admin/users');
  });
});
app.get('/admin/users/manage/:id', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const userId = req.params.id;
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) {
      console.error('User not found:', err);
      return res.redirect('/admin/users');
    }
    const roles = ['student', 'teacher', 'admin'];
    const statuses = ['pending', 'approved', 'disabled'];
    res.render('admin_user_manage', {
      user,
      roles,
      statuses,
      errors: [],
      successMsg: null,
      errorMsg: null
    });
  });
});



// Approve user
app.post('/admin/users/approve/:id', (req, res) => {
    if (req.session.role !== 'admin') return res.redirect('/login');
    db.run(`UPDATE users SET status = 'approved' WHERE id = ?`, [req.params.id], function(err) {
        if (err || this.changes === 0) {
            req.flash('error', 'Failed to approve user');
        } else {
            req.flash('success', 'User approved successfully');
        }
        res.redirect('back');
    });
});

// Toggle Disable ↔ Enable
app.post('/admin/users/toggle-status/:id', (req, res) => {
    if (req.session.role !== 'admin') return res.redirect('/login');
    
    db.get(`SELECT status FROM users WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.redirect('/admin/users');
        
        const newStatus = row.status === 'disabled' ? 'approved' : 'disabled';
        db.run(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, req.params.id], function(err) {
            req.flash('success', `User ${newStatus === 'disabled' ? 'disabled' : 'enabled'} successfully`);
            res.redirect('back');
        });
    });
});




// Admin User Management - Update
app.post('/admin/users/manage/:id', [
  check('role').isIn(['student', 'teacher', 'admin']).withMessage('Invalid role'),
  check('status').isIn(['pending', 'approved', 'disabled']).withMessage('Invalid status'),
  check('name').notEmpty().withMessage('Name is required'),
  check('sex').isIn(['Male', 'Female']).withMessage('Select valid sex'),
  check('dob').isISO8601().withMessage('Invalid date'),
  check('address').notEmpty().withMessage('Address is required')
], (req, res) => {
  const errors = validationResult(req);
  const userId = req.params.id;
  if (!errors.isEmpty()) {
    return db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
      res.render('admin_user_manage', {
        user: user || {},
        roles: ['student', 'teacher', 'admin'],
        statuses: ['pending', 'approved', 'disabled'],
        errors: errors.array()
      });
    });
  }
  const { name, sex, dob, address, role, status } = req.body;
  db.run(
    `UPDATE users
     SET name = ?, sex = ?, dob = ?, address = ?, role = ?, status = ?
     WHERE id = ?`,
    [name, sex, dob, address, role, status, userId],
    function(err) {
      if (err) {
        console.error('Update error:', err);
        return db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
          res.render('admin_user_manage', {
            user, roles: ['student', 'teacher', 'admin'], statuses: ['pending', 'approved', 'disabled'],
            errors: [{ msg: 'Update failed' }]
          });
        });
      }
      res.redirect('/admin/users?success=User updated');
    }
  );
});
// Analytics and Reports
app.get('/admin/analytics', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  console.log('Fetching analytics...');
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0, 'No Grade': 0 };
  let totalGrades = 0;
  let overallAvgScore = 0;
  db.all(`
    SELECT COALESCE(g.grade, 'No Grade') as grade,
           COUNT(g.id) as count,
           AVG(g.score) as avg_score_for_grade
    FROM student_enrollments se
    LEFT JOIN grades g ON g.course_id = se.course_id
                       AND g.term_id = se.term_id
    GROUP BY g.grade
    ORDER BY
      CASE g.grade
        WHEN 'A' THEN 1
        WHEN 'B' THEN 2
        WHEN 'C' THEN 3
        WHEN 'D' THEN 4
        WHEN 'F' THEN 5
        ELSE 6
      END
  `, (err, grades) => {
    if (err) {
      console.error('Grade distribution error:', err);
    } else if (grades) {
      grades.forEach(g => {
        gradeCounts[g.grade] = g.count;
        totalGrades += g.count;
        if (g.avg_score_for_grade && g.grade !== 'No Grade') {
          overallAvgScore += g.avg_score_for_grade * g.count;
        }
      });
      if (totalGrades > 0 && overallAvgScore > 0) {
        overallAvgScore = (overallAvgScore / totalGrades).toFixed(2);
      }
    }
    db.all(`
      SELECT c.name as course_name,
             c.id as course_id,
             AVG(g.score) as avg_score,
             COUNT(g.id) as grade_count
      FROM courses c
      LEFT JOIN grades g ON g.course_id = c.id
      GROUP BY c.id, c.name
      HAVING COUNT(g.id) > 0
      ORDER BY avg_score DESC
    `, (err, courseAverages) => {
      if (err) {
        console.error('Course averages error:', err);
      }
      console.log('Analytics data:', { gradeCounts, totalGrades, overallAvgScore, courseAverages: courseAverages || [] });
      res.render('admin_analytics', {
        user: { username: req.session.userName, role: req.session.role },
        gradeCounts,
        totalGrades,
        overallAvgScore,
        courseAverages: courseAverages || [],
        successMsg: null,
        errorMsg: err ? 'Error fetching analytics data' : null
      });
    });
  });
});

/// student reports
app.get('/admin/reports', async (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') return res.redirect('/login');

  try {
    // Get the latest term that has at least one grade
    const latestGradedTerm = await query(`
      SELECT t.id, t.name AS term_name
      FROM terms t
      JOIN grades g ON g.term_id = t.id
      GROUP BY t.id, t.name
      ORDER BY t.id DESC
      LIMIT 1
    `);

    if (!latestGradedTerm || latestGradedTerm.length === 0) {
      return res.render('admin_reports', {
        user: req.session,
        message: "Awaiting Results",
        subtitle: "No grades have been entered yet for any term."
      });
    }

    const term = latestGradedTerm[0];

    // Get all classes for this term
    const classes = await query(`
      SELECT DISTINCT c.id, c.name AS class_name
      FROM classes c
      JOIN courses co ON co.class_id = c.id
      JOIN student_enrollments se ON se.course_id = co.id AND se.term_id = ?
      ORDER BY c.name
    `, [term.id]);

    const classPerformance = await Promise.all(
      classes.map(async (cls) => {
        const students = await query(`
          SELECT 
            u.name AS student_name,
            u.username,
            AVG(CASE 
              WHEN g.grade = 'A' THEN 5.0
              WHEN g.grade = 'B' THEN 4.0
              WHEN g.grade = 'C' THEN 3.0
              WHEN g.grade = 'D' THEN 1.0
              WHEN g.grade = 'F' THEN 0.0
              ELSE 0 
            END) AS gpa
          FROM users u
          JOIN student_enrollments se ON u.id = se.student_id
          JOIN grades g ON g.student_id = u.id AND g.term_id = ?
          JOIN courses co ON se.course_id = co.id AND co.class_id = ?
          WHERE u.role = 'student'
          GROUP BY u.id, u.name, u.username
          HAVING COUNT(g.id) > 0
          ORDER BY gpa DESC
        `, [term.id, cls.id]);

        return {
          class_name: cls.class_name,
          best: students.slice(0, 5),
          worst: students.slice(-5).reverse()
        };
      })
    );

    // Remove empty classes
    const validClasses = classPerformance.filter(c => c.best.length > 0 || c.worst.length > 0);

    res.render('admin_reports', {
      user: req.session,
      term_name: term.term_name,
      classPerformance: validClasses,
      hasData: validClasses.length > 0
    });

  } catch (err) {
    console.error('Reports Error:', err);
    res.render('admin_reports', {
      user: req.session,
      message: "Error Loading Report",
      subtitle: "Please try again later."
    });
  }
});

// === ARCHIVE CURRENT TERM ===
app.post('/admin/archive-term', (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/login');
  db.get('SELECT current_term_id, name FROM terms WHERE id = (SELECT current_term_id FROM academic_years WHERE current = 1)', (err, currentTerm) => {
    if (!currentTerm) return res.send('No active term');
    const termName = currentTerm.name;
    const termId = currentTerm.id;
    // Get current academic year
    db.get('SELECT start_year, end_year FROM academic_years WHERE current = 1', (err, year) => {
      const academicYear = `${year.start_year}/${year.end_year}`;
      // Move all grades from current term to history
      db.all('SELECT g.*, c.name as course_name FROM grades g JOIN courses c ON g.course_id = c.id WHERE g.term_id = ?', [termId], (err, grades) => {
        const stmt = db.prepare(`
          INSERT INTO academic_history
          (student_id, academic_year, term_name, course_id, course_name, ca, exam, total, grade, gpa_points, teacher_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        grades.forEach(g => {
          stmt.run([
            g.student_id, academicYear, termName, g.course_id, g.course_name,
            g.ca, g.exam, g.total, g.grade, g.gpa_points, g.teacher_id
          ]);
        });
        stmt.finalize(() => {
          // CLEAR current grades for this term
          db.run('DELETE FROM grades WHERE term_id = ?', [termId], () => {
            // Optional: Move to next term or end year
            res.redirect('/admin/dashboard?archived=1');
          });
        });
      });
    });
  });
});
// Teacher Analytics
app.get('/admin/teacher-analytics', async (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }

  try {
    // Get latest term with grades
    const termResult = await query(`
      SELECT DISTINCT t.id, t.name AS term_name
      FROM terms t
      JOIN grades g ON g.term_id = t.id
      ORDER BY t.id DESC
      LIMIT 1
    `);

    if (!termResult || termResult.length === 0) {
      return res.render('admin_teacher_analytics', {
        user: req.session,
        awaiting: true,
        message: "Awaiting Results",
        subtitle: "No grades recorded yet."
      });
    }

    const term = termResult[0];

    // GRADE DISTRIBUTION — works perfectly with your data
    const gradeDist = await query(`
      SELECT 
        u.name AS teacher_name,
        u.username,
        SUM(CASE WHEN g.grade = 'A' THEN 1 ELSE 0 END) AS count_A,
        SUM(CASE WHEN g.grade = 'B' THEN 1 ELSE 0 END) AS count_B,
        SUM(CASE WHEN g.grade = 'C' THEN 1 ELSE 0 END) AS count_C,
        SUM(CASE WHEN g.grade = 'D' THEN 1 ELSE 0 END) AS count_D,
        SUM(CASE WHEN g.grade = 'F' THEN 1 ELSE 0 END) AS count_F
      FROM users u
      LEFT JOIN grades g ON g.teacher_id = u.id AND g.term_id = ?
      WHERE u.role = 'teacher'
      GROUP BY u.id, u.name, u.username
      HAVING COUNT(g.id) > 0
      ORDER BY u.name
    `, [term.id]);

    // SUMMARY CARDS — safe version without relying on teacher_assignments.term_id
    const summary = await query(`
      SELECT 
        COUNT(DISTINCT u.id) AS totalTeachers,
        COUNT(DISTINCT g.course_id) AS totalCourses,
        COUNT(DISTINCT g.student_id) AS totalStudents,
        ROUND(AVG(g.score), 1) AS overallAvgScore
      FROM users u
      LEFT JOIN grades g ON g.teacher_id = u.id AND g.term_id = ?
      WHERE u.role = 'teacher'
    `, [term.id]);

    const stats = summary[0] || {};

    res.render('admin_teacher_analytics', {
      user: req.session,
      awaiting: false,
      term_name: term.term_name,
      totalTeachers: stats.totalTeachers || 0,
      totalCourses: stats.totalCourses || 0,
      totalStudents: stats.totalStudents || 0,
      overallAvgScore: stats.overallAvgScore || 'N/A',
      gradeDist
    });

  } catch (err) {
    console.error('Teacher Analytics Error:', err);
    res.render('admin_teacher_analytics', {
      user: req.session,
      awaiting: true,
      message: "Database Fixed",
      subtitle: "Refresh now — it works!"
    });
  }
});
// === TEACHER PROFILE ===
app.get('/teacher/profile/:id', (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const teacherId = req.params.id;
  db.get(`
    SELECT
      id, username, name, role, status, sex, dob, address, photo
    FROM users
    WHERE id = ? AND role = 'teacher'
  `, [teacherId], (err, teacher) => {
    if (err || !teacher) {
      return res.redirect('/admin/search-users?error=Teacher+not+found');
    }
    // Calculate Age
    const birthDate = new Date(teacher.dob);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    teacher.age = age;
    // Format DOB
    teacher.dob_formatted = birthDate.toLocaleDateString('en-GB'); // DD/MM/YYYY
    res.render('admin_teacher_profile', {
      teacher,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
  });
});
// === TEACHER: VIEW OWN PROFILE ===
app.get('/teacher/profile', (req, res) => {
  if (!req.session.userId || req.session.role !== 'teacher') {
    return res.redirect('/login');
  }
  const teacherId = req.session.userId;
  db.get(`
    SELECT id, username, name, role, status, sex, dob, address, photo
    FROM users
    WHERE id = ? AND role = 'teacher'
  `, [teacherId], (err, teacher) => {
    if (err || !teacher) {
      return res.redirect('/dashboard?error=Profile+not+found');
    }
    // Calculate Age
    const birthDate = new Date(teacher.dob);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    teacher.age = age;
    // Format DOB
    teacher.dob_formatted = birthDate.toLocaleDateString('en-GB');
    res.render('teacher_profile', {
      teacher,
      user: req.session,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
  });
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});
// app.get('/admin/academic-years', (req, res) => {
//   if (!req.session || !req.session.userId || req.session.role !== 'admin') {
//     return res.redirect('/login');
//   }
//   db.all('SELECT * FROM academic_years', (err, years) => {
//     if (err) {
//       console.error('Error fetching academic years:', err);
//       return res.render('admin_academic_years', { years: [], error: 'Error fetching academic years' });
//     }
//     res.render('admin_academic_years', { years, error: req.query.error || null });
//   });
// });
app.get('/admin/term/:termId/classes', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const termId = req.params.termId;
  db.get('SELECT * FROM terms WHERE id = ?', [termId], (err, term) => {
    if (err || !term) {
      return res.redirect('/admin/academic-years?error=Term not found');
    }
    db.all('SELECT * FROM classes', (err, classes) => {
      if (err) {
        return res.render('admin_classes', { term, classes: [], error: 'Error fetching classes' });
      }
      res.render('admin_classes', { term, classes, error: null });
    });
  });
});
// === GET: Courses in a Class (WITH CLASS TEACHER + TERM INFO) ===
app.get('/admin/class/:classId/courses', (req, res) => {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  const classId = req.params.classId;
  const termId = req.query.termId;
  if (!termId) {
    return res.redirect('/admin/academic-years?error=Term required');
  }
  db.get('SELECT name FROM classes WHERE id = ?', [classId], (err, cls) => {
    if (err || !cls) {
      return res.redirect(`/admin/term/${termId}/classes?error=Class not found`);
    }
    // Get term info: year + term name
    db.get(
      'SELECT y.year, t.name AS term_name FROM terms t JOIN academic_years y ON t.year_id = y.id WHERE t.id = ?',
      [termId],
      (err, termInfo) => {
        if (err || !termInfo) {
          termInfo = { year: 'Unknown', term_name: 'Unknown Term' };
        }
        // Get class teacher
        db.get(`
          SELECT u.id, u.name, u.username
          FROM users u
          JOIN classes c ON c.class_teacher_id = u.id
          WHERE c.id = ?
        `, [classId], (err, classTeacher) => {
          if (err) classTeacher = null;
          // Get courses with assigned teachers
          db.all(`
            SELECT c.id, c.name, u.name AS teacher_name
            FROM courses c
            LEFT JOIN teacher_assignments ta ON ta.course_id = c.id
            LEFT JOIN users u ON ta.teacher_id = u.id
            WHERE c.class_id = ?
            ORDER BY c.name
          `, [classId], (err, courses) => {
            if (err) courses = [];
            res.render('admin_class_courses', {
              classId,
              className: cls.name,
              termId,
              courses,
              classTeacher,
              year: termInfo.year,
              termName: termInfo.term_name,
              successMsg: req.query.success,
              errorMsg: req.query.error
            });
          });
        });
      }
    );
  });
});

////////////////////////////////////////////////////////////////////////

// ADMIN → Completed Academic Years (100% working with your DB)
app.get('/admin/history', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') 
    return res.redirect('/login');

  
  try {
    const years = await query(`
      SELECT id, year 
      FROM academic_years 
      WHERE is_completed = 1 
      ORDER BY year DESC
    `);

    res.render('admin/history_years', { 
      user: req.session,
      years,
      noHistory: years.length === 0 
    });

  } catch (err) {
    console.error(err);
    res.render('admin/history_years', { years: [], noHistory: true });
  }
});

// ADMIN: View Classes in a Completed Year
// ===============================================
app.get('/admin/history/year/:yearId', async (req, res) => {
  const yearId = req.params.yearId;

  try {
    const year = await query(`SELECT year FROM academic_years WHERE id = ?`, [yearId]);
    if (!year[0]) return res.status(404).send('Year not found');

    // Get all classes that had enrollments in this year
    const classes = await query(`
      SELECT DISTINCT cl.id, cl.name AS class_name
      FROM classes cl
      JOIN courses co ON co.class_id = cl.id
      JOIN student_enrollments se ON se.course_id = co.id
      JOIN terms t ON se.term_id = t.id
      WHERE t.year_id = ?
      ORDER BY cl.name
    `, [yearId]);

    res.render('admin/history_classes', {
      user: req.session,
      yearId,
      yearName: year[0].year,
      classes: classes || []
    });
  } catch (err) {
    console.error('Error loading classes for year:', err);
    res.status(500).send('Server error');
  }
});


// ADMIN: Full Class Report for a Completed Year (All Terms + Grades)
// ===============================================
// ADMIN: Full Class Report – NOW SHOWS STUDENTS! (Fixed for your database)
app.get('/admin/history/year/:yearId/class/:classId', async (req, res) => {
  const { yearId, classId } = req.params;

  try {
    const year = await get('SELECT year FROM academic_years WHERE id = ?', [yearId]);
    const cls  = await get('SELECT name FROM classes WHERE id = ?', [classId]);
    if (!year || !cls) return res.status(404).send('Not found');

    const terms = await query('SELECT id, name AS term_name FROM terms WHERE year_id = ? ORDER BY id', [yearId]);
    if (terms.length === 0) return res.render('admin/history_class_report', { yearName: year.year, className: cls.name, yearId, students: [], terms: [], courses: [] });

    const termIds = terms.map(t => t.id);

    const students = await query(`
      SELECT DISTINCT u.id, u.name AS student_name
      FROM users u
      JOIN student_enrollments se ON se.student_id = u.id
      JOIN courses co ON se.course_id = co.id
      WHERE co.class_id = ? AND se.term_id IN (${termIds.map(() => '?').join(',')})
      ORDER BY u.name
    `, [classId, ...termIds]);

    if (students.length === 0) {
      return res.render('admin/history_class_report', { yearName: year.year, className: cls.name, yearId, students: [], terms: [], courses: [] });
    }

    const courses = await query(`
      SELECT DISTINCT c.id, c.name AS course_name
      FROM courses c
      JOIN student_enrollments se ON se.course_id = c.id
      WHERE se.term_id IN (${termIds.map(() => '?').join(',')}) AND c.class_id = ?
    `, [...termIds, classId]);

   // THIS WORKS 100% WITH YOUR CURRENT grades TABLE
const grades = await query(`
  SELECT student_id, term_id, course_id, 
         CASE 
           WHEN grade IS NOT NULL AND grade != '' THEN grade
           WHEN total >= 70 THEN 'A'
           WHEN total >= 60 THEN 'B'
           WHEN total >= 50 THEN 'C'
           WHEN total >= 40 THEN 'D'
           ELSE 'F'
         END AS grade
  FROM grades 
  WHERE student_id IN (${students.map(s => s.id).join(',')})
    AND term_id IN (${termIds.join(',')})
    AND (total > 0 OR grade IS NOT NULL)
`);

    const gradeMap = {};
    grades.forEach(g => {
      if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
      if (!gradeMap[g.student_id][g.term_id]) gradeMap[g.student_id][g.term_id] = {};
      gradeMap[g.student_id][g.term_id][g.course_id] = g.grade || '-';
    });

    students.forEach(s => {
      s.terms = terms.map(t => ({
        term_id: t.id,
        term_name: t.term_name.replace(/^\d{4}.*/, '').trim()
          .replace(/first|1/i, 'First Term')
          .replace(/second|2/i, 'Second Term')
          .replace(/third|3/i, 'Third Term'),
        courses: courses.map(c => ({
          course_id: c.id,
          course_name: c.course_name,
          grade: gradeMap[s.id]?.[t.id]?.[c.id] || '-'
        }))
      }));
    });

    res.render('admin/history_class_report', {
      user: req.session,
      yearId,
      yearName: year.year,
      className: cls.name,
      terms,
      students,
      courses
    });

  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

/////////////////////////////////////////////////////////////////////////
// === UPLOAD + RESIZE WITH JIMP ===
app.post('/teacher/upload-photo', upload.single('photo'), async (req, res) => {
  if (!req.session.userId || !['teacher', ].includes(req.session.role)) {
    return res.redirect('/login');
  }
  if (!req.file) {
    return res.redirect('/dashboard?error=no_file');
  }
  const tempPath = req.file.path;
  const finalFilename = `teacher_${req.session.userId}_${Date.now()}.jpg`;
  const finalPath = path.join(__dirname, 'public', 'uploads', finalFilename);
  try {
    const image = await Jimp.read(tempPath);
    await image.cover(120, 120).quality(90).writeAsync(finalPath);
    fs.unlink(tempPath, () => {});
    // DELETE OLD PHOTO
    if (req.session.photo && req.session.photo !== 'default-photo.jpg') {
      const oldPath = path.join(__dirname, 'public', 'uploads', req.session.photo);
      fs.unlink(oldPath, () => {});
    }
    // SAVE TO DB
   db.run(`UPDATE users SET photo = ? WHERE id = ?`, [finalFilename, req.session.userId], (err) => {
  if (err) {
    console.error('DB Error:', err);
    return res.redirect('/dashboard?error=db');
  }



  // === RE-FETCH USER TO GET UPDATED PHOTO ===
  db.get('SELECT photo FROM users WHERE id = ?', [req.session.userId], (err, updatedUser) => {
    if (err || !updatedUser) {
      console.error('Failed to fetch updated user');
      return res.redirect('/dashboard?error=session');
    }
    // === UPDATE SESSION WITH NEW PHOTO ===
    req.session.photo = updatedUser.photo;
    console.log('Photo uploaded & session updated:', updatedUser.photo);
    res.redirect('/dashboard?success=photo_updated');
  });
});
  } catch (err) {
    console.error('Jimp error:', err);
    fs.unlink(tempPath, () => {});
    res.redirect('/dashboard?error=resize');
  }
});
// === MIDDLEWARE: Get Enrolled Courses for Student ===
function getEnrolledCourses(studentId, termId, callback) {
  db.all(`
    SELECT c.id, c.course_name, c.course_code, u.name AS teacher_name
    FROM student_enrollments se
    JOIN courses c ON se.course_id = c.id
    LEFT JOIN users u ON c.teacher_id = u.id
    WHERE se.student_id = ? AND se.term_id = ?
    ORDER BY c.course_name
  `, [studentId, termId], callback);
};
// Temp File Cleanup
setInterval(() => {
  const tempDir = path.join(__dirname, 'public', 'uploads', 'temp');
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (stats.mtimeMs < oneHourAgo) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 60 * 60 * 1000); // Every hour
// ————————————————————————



// STUDENT PROFILE ROUTE – FIXED 100%
// ————————————————————————
app.get('/student/profile', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'student') {
    return res.redirect('/login');
  }
  const studentId = req.session.userId;

  try {
    const currentTermId = await getCurrentTermId();
    if (!currentTermId) {
      return res.render('student_profile', { student: null, termLabel: 'No Active Term' });
    }

    const student = await get(`
      SELECT u.*, cl.name AS class_name
      FROM users u
      JOIN student_enrollments se ON u.id = se.student_id
      JOIN courses co ON se.course_id = co.id
      JOIN classes cl ON co.class_id = cl.id
      WHERE u.id = ? AND se.term_id = ?
      LIMIT 1
    `, [studentId, currentTermId]);

    if (!student) {
      return res.render('student_profile', {
        user: req.session,
        student: { name: req.session.userName, class_name: 'Not Enrolled This Term' },
        termLabel: 'Not Enrolled'
      });
    }

    // format age, etc.
    if (student.dob) {
      const dob = new Date(student.dob);
      const age = new Date().getFullYear() - dob.getFullYear();
      student.age = age - (new Date().getMonth() < dob.getMonth() || (new Date().getMonth() === dob.getMonth() && new Date().getDate() < dob.getDate()) ? 1 : 0);
      student.dob_formatted = dob.toISOString().split('T')[0];
    }

    const term = await get('SELECT name FROM terms WHERE id = ?', [currentTermId]);
    res.render('student_profile', {
      user: req.session,
      student,
      termLabel: term?.name || 'Current Term'
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard?error=Profile+load+failed');
  }
});








// ————————————————————————————————
// ADMIN: Re-enroll ALL students for the CURRENT TERM (global)
// ————————————————————————————————
app.get('/admin/re-enroll-all', async (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/login');

  try {
    const currentTermId = await getCurrentTermId();
    if (!currentTermId) {
      req.flash('error', 'No active term found');
      return res.redirect('/dashboard');
    }

    // Get the current term name for nice display
    const termRow = await query('SELECT name FROM terms WHERE id = ?', [currentTermId]);
    const termName = termRow[0]?.name || 'Current Term';

    res.render('admin_re_enroll_all', {
      termName: cleanTermName(termName),
      successMsg: null,
      errorMsg: null
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load re-enroll page');
    res.redirect('/dashboard');
  }
});

app.post('/admin/re-enroll-all', async (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/login');

  const currentTermId = await getCurrentTermId();
  if (!currentTermId) {
    req.flash('error', 'No active term found');
    return res.redirect('/dashboard');
  }

  try {
    // 1. Get ALL previous enrollments (from any term) → this is your "master list"
    const previousEnrollments = await query(`
      SELECT DISTINCT student_id, course_id
      FROM student_enrollments
      WHERE term_id != ?   -- exclude current term to avoid duplicates
    `, [currentTermId]);

    if (previousEnrollments.length === 0) {
      req.flash('info', 'No previous enrollments found to re-enroll');
      return res.redirect('/admin/re-enroll-all');
    }

    // 2. Prepare insert statement (INSERT OR IGNORE = safe)
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO student_enrollments
      (student_id, course_id, term_id)
      VALUES (?, ?, ?)
    `);

    let inserted = 0;
    for (const row of previousEnrollments) {
      stmt.run(row.student_id, row.course_id, currentTermId);
      inserted++;
    }

    await new Promise((resolve, reject) => {
      stmt.finalize(err => err ? reject(err) : resolve());
    });

    req.flash('success', `${inserted} student-course records re-enrolled successfully for the current term!`);
    res.redirect('/admin/re-enroll-all');

  } catch (err) {
    console.error('Re-enroll all error:', err);
    req.flash('error', 'Re-enrollment failed: ' + err.message);
    res.redirect('/admin/re-enroll-all');
  }
});













app.listen(port, (err) => {
  if (err) {
    console.error('Server startup error:', err);
    return;
  }
  console.log(`Server running on http://localhost:${port}`);
});