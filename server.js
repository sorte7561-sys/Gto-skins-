import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WHATSAPP_NUMBER = String(process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');

const supabaseAdmin = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function requireServer() {
  if (!supabaseAdmin) throw new Error('Servidor sem SUPABASE_SECRET_KEY.');
}

async function requireAdmin(req, res, next) {
  try {
    requireServer();
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Sessão inválida.' });
    const { data: profile, error: pErr } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (pErr || profile?.role !== 'admin') return res.status(403).json({ error: 'Acesso de administrador negado.' });
    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.get('/api/config', (_req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY, whatsappNumber: WHATSAPP_NUMBER });
});

app.get('/api/products', async (_req, res) => {
  try {
    requireServer();
    const { data, error } = await supabaseAdmin.from('products')
      .select('id,name,description,category,price,image_url,download_path,active,created_at')
      .eq('active', true).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    requireServer();
    const { customer_name, customer_email, items } = req.body || {};
    if (!customer_name || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'Nome e itens são obrigatórios.' });

    const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
    const { data: products, error: pErr } = await supabaseAdmin.from('products')
      .select('id,name,price,active').in('id', ids).eq('active', true);
    if (pErr) throw pErr;
    const map = new Map((products || []).map(p => [p.id, p]));
    const normalized = items.map(i => ({
      product_id: i.product_id,
      quantity: Math.max(1, Math.min(99, Number(i.quantity || 1)))
    })).filter(i => map.has(i.product_id));
    if (!normalized.length) return res.status(400).json({ error: 'Nenhum produto válido.' });

    const total = normalized.reduce((sum, i) => sum + Number(map.get(i.product_id).price) * i.quantity, 0);

    const { data: order, error: oErr } = await supabaseAdmin.from('orders').insert({
      customer_name: String(customer_name).trim(),
      customer_email: customer_email ? String(customer_email).trim() : null,
      status: 'PENDENTE',
      total: total.toFixed(2)
    }).select('*').single();
    if (oErr) throw oErr;

    const rows = normalized.map(i => ({
      order_id: order.id,
      product_id: i.product_id,
      product_name: map.get(i.product_id).name,
      price: map.get(i.product_id).price,
      quantity: i.quantity
    }));
    const { error: oiErr } = await supabaseAdmin.from('order_items').insert(rows);
    if (oiErr) throw oiErr;

    res.json({ order_id: order.id, access_token: order.access_token, status: 'PENDENTE', total: Number(total.toFixed(2)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:token', async (req, res) => {
  try {
    requireServer();
    const { data: order, error } = await supabaseAdmin.from('orders')
      .select('id,customer_name,customer_email,status,total,access_token,created_at,paid_at')
      .eq('access_token', req.params.token).single();
    if (error || !order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const { data: items } = await supabaseAdmin.from('order_items')
      .select('product_id,product_name,price,quantity').eq('order_id', order.id);

    const downloads = [];
    if (order.status === 'PAGO') {
      for (const item of items || []) {
        if (!item.product_id) continue;
        const { data: product } = await supabaseAdmin.from('products')
          .select('id,download_path').eq('id', item.product_id).maybeSingle();
        if (!product?.download_path) continue;
        const { data: signed } = await supabaseAdmin.storage.from('Skins')
          .createSignedUrl(product.download_path, 60 * 60);
        if (signed?.signedUrl) downloads.push({ product_id: product.id, url: signed.signedUrl });
      }
    }
    res.json({ ...order, items: items || [], downloads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin.from('orders').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['PENDENTE','PAGO','CANCELADO','ESTORNADO'];
  const status = String(req.body?.status || '').toUpperCase();
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  const patch = { status };
  if (status === 'PAGO') patch.paid_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('orders').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { name, description, category, price, image_url, download_path, active } = req.body || {};
  const { data, error } = await supabaseAdmin.from('products').insert({
    name, description: description || null, category: category || 'Caminhões',
    price: Number(price || 0), image_url: image_url || null,
    download_path: download_path || null, active: active !== false
  }).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const allowed = ['name','description','category','price','image_url','download_path','active'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if ('price' in patch) patch.price = Number(patch.price);
  const { data, error } = await supabaseAdmin.from('products').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// Frontend files are in the repository root for easy upload from a phone.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin/', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/admin.js', (_req, res) => res.sendFile(path.join(__dirname, 'admin.js')));

app.listen(PORT, () => console.log(`GTO Skins rodando em ${APP_URL}`));
