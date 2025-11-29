const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'app.js');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

const stack = [];
const extras = [];

lines.forEach((ln, idx) => {
  const lineNum = idx + 1;
  for (let i = 0; i < ln.length; i++) {
    const ch = ln[i];
    if (ch === '{') {
      stack.push({ line: lineNum, col: i + 1 });
    } else if (ch === '}') {
      if (stack.length === 0) {
        extras.push({ line: lineNum, col: i + 1 });
      } else {
        stack.pop();
      }
    }
  }
});

if (stack.length === 0 && extras.length === 0) {
  console.log('OK: All braces matched.');
  process.exit(0);
}

if (stack.length) {
  console.log('UNMATCHED OPENING BRACES (no closing found):');
  stack.forEach(s => console.log(`  { at line ${s.line}, col ${s.col}`));
}
if (extras.length) {
  console.log('EXTRA CLOSING BRACES (no opening found):');
  extras.forEach(e => console.log(`  } at line ${e.line}, col ${e.col}`));
}

process.exit(0);
