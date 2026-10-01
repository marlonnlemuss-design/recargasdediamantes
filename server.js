require('dotenv').config();
const express = require('express'), path = require('path');
const Stripe = require('stripe'), Database = require('better-sqlite3'), nodemailer = require('nodemailer');
const cfg = require('./prices.json');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const db = new Database('orders.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, session TEXT UNIQUE, pkg TEXT, qty INT, player_id TEXT,
  name TEXT, email TEXT, total REAL, status TEXT DEFAULT 'pagado',
  created TEXT DEFAULT CURRENT_TIMESTAMP)`);
const mail = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

// Precio = costo / (1 - comisión - margen). Siempre se calcula en el servidor.
const price = c => Math.ceil(c / (1 - (cfg.feePct + cfg.marginPct) / 100) * 100) / 100;
const active = () => cfg.packages.filter(p => p.active !== false);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = express();

// Webhook: va ANTES de express.json() (necesita el cuerpo crudo)
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  if (ev.type === 'checkout.session.completed') {
    const s = ev.data.object, m = s.metadata, email = s.customer_details.email;
    db.prepare('INSERT OR IGNORE INTO orders(session,pkg,qty,player_id,name,email,total) VALUES(?,?,?,?,?,?,?)')
      .run(s.id, m.pkg, +m.qty, m.player_id, m.name, email, s.amount_total / 100);
    mail && mail.sendMail({
      from: process.env.MAIL_FROM, to: email, subject: 'Recibimos tu pedido',
      text: `Pago recibido: Q${s.amount_total / 100}.\nRecargaremos ${m.qty} x ${m.pkg} al ID ${m.player_id}.`
    }).catch(console.error);
  }
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/packages', (_q, r) => r.json(active().map(p => ({ id: p.id, name: p.name, tag: p.tag, price: price(p.cost) }))));

app.post('/api/checkout', async (req, res) => {
  const { pkg, qty, playerId, name, lastName, email } = req.body || {};
  const p = active().find(x => x.id === pkg), n = Number(qty);
  if (!p || !Number.isInteger(n) || n < 1 || n > 10) return res.status(400).json({ error: 'Paquete o cantidad inválidos' });
  if (!/^\d{6,15}$/.test(playerId || '')) return res.status(400).json({ error: 'ID inválido' });
  if (!name || !lastName || !/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const s = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: email,
      line_items: [{ quantity: n, price_data: { currency: 'gtq', unit_amount: Math.round(price(p.cost) * 100), product_data: { name: p.name } } }],
      metadata: { pkg: p.name, qty: String(n), player_id: playerId, name: `${name} ${lastName}`.slice(0, 100) },
      success_url: `${process.env.BASE_URL}/?ok=1`, cancel_url: `${process.env.BASE_URL}/?cancel=1`
    });
    res.json({ url: s.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo iniciar el pago' }); }
});

// Panel admin (HTTP Basic). Úsalo solo con HTTPS.
const auth = (req, res, next) => {
  const [u, pw] = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString().split(':');
  if (u === process.env.ADMIN_USER && pw && pw === process.env.ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="admin"').sendStatus(401);
};
app.post('/admin/orders/:id', auth, (req, res) => {
  if (!['pagado', 'en proceso', 'entregado'].includes(req.body.status)) return res.sendStatus(400);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.sendStatus(204);
});
app.get('/admin', auth, (_q, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map(o => `<tr>
    <td>${o.id}</td><td>${esc(o.created)}</td><td>${esc(o.pkg)} ×${o.qty}</td><td><b>${esc(o.player_id)}</b></td>
    <td>${esc(o.name)}<br>${esc(o.email)}</td><td>Q${o.total}</td>
    <td><select onchange="fetch('/admin/orders/${o.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:this.value})})">
    ${['pagado', 'en proceso', 'entregado'].map(s => `<option${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('');
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Pedidos</title>
  <style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}div{overflow-x:auto}</style>
  <h1>Pedidos</h1><div><table><tr><th>#<th>Fecha<th>Paquete<th>ID jugador<th>Cliente<th>Total<th>Estado</tr>${rows}</table></div>`);
});

app.listen(process.env.PORT || 3000, () => console.log('Tienda lista'));
