// Simula dues persones (Ana i Marc) treballant amb IA a la mateixa sala, per veure la web en acció.
// Ús: node scripts/demo.js [sala] [servidor]
const room = process.argv[2] || 'demo';
const server = (process.argv[3] || 'http://localhost:4321').replace(/\/$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(member, action, body) {
  const res = await fetch(`${server}/api/rooms/${encodeURIComponent(room)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ member, ...body }),
  });
  return res.json();
}

const steps = [
  ['Ana', 'intent', { text: 'Afegeix inici de sessió amb email i contrasenya' }],
  ['Marc', 'intent', { text: 'Fes la pàgina de perfil d\'usuari amb avatar' }],
  ['Ana', 'activity', { kind: 'read', tool: 'Read', summary: 'Ha llegit src/routes.js', files: ['src/routes.js'] }],
  ['Marc', 'activity', { kind: 'read', tool: 'Glob', summary: 'Ha buscat fitxers src/**/*.jsx' }],
  ['Ana', 'claim', { files: ['src/auth.js'] }],
  ['Ana', 'activity', {
    kind: 'edit', tool: 'Write', summary: 'Ha escrit src/auth.js (14 línies)', files: ['src/auth.js'],
    diff: { old: '', new: "import bcrypt from 'bcryptjs';\n\nexport async function login(email, password) {\n  const user = await db.users.findByEmail(email);\n  if (!user) return null;\n  return (await bcrypt.compare(password, user.hash)) ? user : null;\n}" },
  }],
  ['Marc', 'claim', { files: ['src/pages/Profile.jsx'] }],
  ['Marc', 'activity', {
    kind: 'edit', tool: 'Edit', summary: 'Ha editat src/pages/Profile.jsx', files: ['src/pages/Profile.jsx'],
    diff: { old: '<h1>Perfil</h1>', new: '<h1>Perfil</h1>\n<Avatar user={user} size={96} />' },
  }],
  ['Ana', 'activity', { kind: 'command', tool: 'Bash', summary: 'Instal·la dependències: $ npm install bcryptjs' }],
  ['Marc', 'claim', { files: ['src/auth.js'] }], // conflicte: és de l'Ana, la seva IA queda bloquejada
  ['Marc', 'note', { from: 'ai', to: 'Ana', text: 'Necessito que auth.js exporti getCurrentUser() per al perfil. Me l\'afegeixes quan acabis?' }],
  ['Ana', 'activity', {
    kind: 'edit', tool: 'Edit', summary: 'Ha editat src/auth.js', files: ['src/auth.js'],
    diff: { old: 'export async function login(email, password) {', new: 'export function getCurrentUser(req) {\n  return req.session?.user ?? null;\n}\n\nexport async function login(email, password) {' },
  }],
  ['Ana', 'note', { from: 'ai', to: 'Marc', text: 'Fet: getCurrentUser(req) ja és a src/auth.js.' }],
  ['Ana', 'status', { status: 'idle', summary: 'Ha acabat el torn' }],
];

console.log(`Demo a ${server}/?room=${room}&name=Ana`);
for (const [member, action, body] of steps) {
  await call(member, action, body);
  process.stdout.write(`  ${member} → ${action}\n`);
  await wait(Number(process.env.DEMO_DELAY ?? 1500));
}
console.log('Demo acabada.');
