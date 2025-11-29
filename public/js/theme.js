// public/js/theme.js
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('theme-toggle');
  const body = document.body;

  if (!toggle) return;

  // Load saved theme
  const savedTheme = localStorage.getItem('theme') || 'light';
  body.setAttribute('data-theme', savedTheme);

  // Toggle handler
  toggle.addEventListener('click', () => {
    const current = body.getAttribute('data-theme');
    const newTheme = current === 'light' ? 'dark' : 'light';
    body.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  });
});