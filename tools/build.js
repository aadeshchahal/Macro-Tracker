'use strict';
// Bundles index.html + style.css + the five scripts into ONE self-contained page (dist/index.html).
// The Claude phone apps render only the page itself, so separate supporting files never load there.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let html = read('index.html');

const cssTag = '<link rel="stylesheet" href="style.css">';
if (!html.includes(cssTag)) throw new Error('style.css link not found in index.html');
const css = read('style.css').replace(/<\/style/gi, '<\\/style');
html = html.replace(cssTag, () => '<style>\n' + css + '\n</style>');

const scripts = ['core.js', 'store.js', 'charts.js', 'app.js', 'screens.js'];
for (const s of scripts) {
  const tag = '<script src="' + s + '"></script>';
  if (!html.includes(tag)) throw new Error(s + ' script tag not found in index.html');
  const js = read(s).replace(/<\/script/gi, '<\\/script');
  html = html.replace(tag, () => '<script>\n/* ---- ' + s + ' ---- */\n' + js + '\n</script>');
}
if (/<script src=|<link rel="stylesheet" href="(?!https:)/.test(html)) throw new Error('an external local reference is still present');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'index.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + ' (' + Buffer.byteLength(html) + ' bytes)');
