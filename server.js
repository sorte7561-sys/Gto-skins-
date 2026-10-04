import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get('/api/config', (_req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY });
});

app.get('/api/products', async (_req, res) => {
  try {
    requireServer();
    const { data, error } = await supabaseAdmin.from('products').select('id,name,description,category,price,image_url,active,created_at').eq('active', true).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    requireServer();
    const { customer_name, customer_email, items } = req.body || {};
    if (!customer_name || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Nome e itens são obrigatórios.' });
    const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
    const { data: products, error: pErr } = await supabaseAdmin.from('products').select('id,name,price,active').in('id', ids).eq('active', true);
    if (pErr) throw pErr;
    const map = new Map((products || []).map(p => [p.id, p]));
    const normalized = items.map(i => ({ product_id: i.product_id, quantity: Math.max(1, Math.min(99, Number(i.quantity || 1))) })).filter(i => map.has(i.product_id));
    if (!normalized.length) return res.status(400).json({ error: 'Nenhum produto válido.' });
    const total = normalized.reduce((sum, i) => sum + Number(map.get(i.product_id).price) * i.quantity, 0);
    const { data: order, error: oErr } = await supabaseAdmin.from('orders').insert({ customer_name: String(customer_name).trim(), customer_email: customer_email ? String(customer_email).trim() : null, status: 'PENDENTE', total: total.toFixed(2) }).select('*').single();
    if (oErr) throw oErr;
    const rows = normalized.map(i => ({ order_id: order.id, product_id: i.product_id, product_name: map.get(i.product_id).name, price: map.get(i.product_id).price, quantity: i.quantity }));
    const { error: oiErr } = await supabaseAdmin.from('order_items').insert(rows);
    if (oiErr) throw oiErr;
    res.json({ order_id: order.id, access_token: order.access_token, status: 'PENDENTE', total: Number(total.toFixed(2)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:token', async (req, res) => {
  try {
    requireServer();
    const { data: order, error } = await supabaseAdmin.from('orders').select('id,customer_name,customer_email,status,total,access_token,created_at,paid_at').eq('access_token', req.params.token).single();
    if (error || !order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const { data: items } = await supabaseAdmin.from('order_items').select('product_id,product_name,price,quantity').eq('order_id', order.id);
    let downloads = [];
    if (order.status === 'PAGO') {
      const ids = (items || []).map(i => i.product_id).filter(Boolean);
      if (ids.length) {
        const { data: products } = await supabaseAdmin.from('products').select('id,download_path').in('id', ids);
        for (const p of products || []) {
          if (!p.download_path) continue;
          const { data: signed } = await supabaseAdmin.storage.from('Skins').createSignedUrl(p.download_path, 60 * 60);
          if (signed?.signedUrl) downloads.push({ product_id: p.id, url: signed.signedUrl });
        }
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
  const { data, error } = await supabaseAdmin.from('products').insert({ name, description: description || null, category: category || 'Caminhões', price: Number(price || 0), image_url: image_url || null, download_path: download_path || null, active: active !== false }).select('*').single();
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

app.post('/api/admin/storage-upload-url', requireAdmin, async (req, res) => {
  const { path: filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path é obrigatório.' });
  const { data, error } = await supabaseAdmin.storage.from('Skins').createSignedUploadUrl(filePath);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


app.listen(PORT, () => console.log(`GTO Skins rodando em ${APP_URL}`));

const INDEX_HTML = "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>GTO Skins</title><style>\n:root{--bg:#090b0d;--card:#12161a;--line:#263039;--green:#19d37b;--text:#f4f7f8;--muted:#98a5ad}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Arial}header{position:sticky;top:0;z-index:5;background:#0b0e10ee;backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}.wrap{max-width:1100px;margin:auto;padding:18px}.nav{display:flex;gap:18px;align-items:center;justify-content:space-between}.logo{font-weight:900;font-size:22px}.logo span{color:var(--green)}button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer}.primary{background:var(--green);color:#04130b}.ghost{background:#182027;color:white;border:1px solid var(--line)}.hero{padding:60px 18px 35px;text-align:center}.hero h1{font-size:clamp(36px,7vw,64px);margin:0 0 12px}.hero p{color:var(--muted);max-width:680px;margin:auto;font-size:18px}.tools{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.tools input,.tools select,input,textarea{background:#0e1317;border:1px solid var(--line);color:white;border-radius:10px;padding:12px}.tools input{flex:1;min-width:200px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}.thumb{aspect-ratio:16/10;background:#0f1316;display:grid;place-items:center;color:#60707a}.thumb img{width:100%;height:100%;object-fit:cover}.body{padding:15px}.body h3{margin:0 0 6px}.muted{color:var(--muted)}.price{font-size:22px;font-weight:900;margin:12px 0}.cart{position:fixed;right:18px;bottom:18px;background:var(--green);color:#04130b;border-radius:999px;padding:15px 20px;font-weight:900;box-shadow:0 10px 30px #0008}.modal{position:fixed;inset:0;background:#000b;display:none;align-items:center;justify-content:center;padding:18px;z-index:20}.modal.open{display:flex}.box{background:#101519;border:1px solid var(--line);border-radius:18px;max-width:520px;width:100%;padding:22px}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0}.qr{max-width:230px;margin:12px auto;display:block}.copy{width:100%;word-break:break-all}.empty{text-align:center;color:var(--muted);padding:40px}.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#172027;border:1px solid var(--line);padding:12px 16px;border-radius:10px;display:none}.toast.show{display:block}</style></head><body><header><div class=\"wrap nav\"><div class=\"logo\">GTO <span>SKINS</span></div><button class=\"ghost\" onclick=\"openOrders()\">Meus pedidos</button></div></header><main><section class=\"hero\"><h1>Skins para sua garagem.</h1><p>Compre suas skins para Global Truck Online. Faça seu pedido e receba a skin após a confirmação do pagamento.</p></section><section class=\"wrap\"><div class=\"tools\"><input id=\"search\" placeholder=\"Buscar skin...\" oninput=\"render()\"><select id=\"cat\" onchange=\"render()\"><option value=\"\">Todas as categorias</option><option>Caminhões</option><option>Reboques</option><option>Bitrens</option><option>Rodotrens</option><option>Ônibus</option></select></div><div id=\"grid\" class=\"grid\"></div></section></main><button class=\"cart\" onclick=\"openCart()\">Carrinho (<span id=\"count\">0</span>)</button><div id=\"modal\" class=\"modal\"><div class=\"box\" id=\"box\"></div></div><div id=\"toast\" class=\"toast\"></div><script src=\"/app.js\"></script></body></html>";
const APP_JS = "let products=[],cart=JSON.parse(localStorage.getItem('gto_cart')||'[]');\nconst $=s=>document.querySelector(s); const money=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});\nasync function load(){const r=await fetch('/api/products'); products=await r.json(); render(); updateCount();}\nfunction render(){const q=($('#search')?.value||'').toLowerCase();const c=$('#cat')?.value||'';const list=products.filter(p=>(!q||`${p.name} ${p.description||''}`.toLowerCase().includes(q))&&(!c||p.category===c));$('#grid').innerHTML=list.length?list.map(p=>`<article class=\"card\"><div class=\"thumb\">${p.image_url?`<img src=\"${esc(p.image_url)}\" alt=\"\">`:'GTO SKINS'}</div><div class=\"body\"><div class=\"muted\">${esc(p.category)}</div><h3>${esc(p.name)}</h3><div class=\"muted\">${esc(p.description||'')}</div><div class=\"price\">${money(p.price)}</div><button class=\"primary\" onclick=\"add('${p.id}')\">Adicionar</button></div></article>`).join(''):'<div class=\"empty\">Nenhuma skin encontrada.</div>'}\nfunction esc(s){return String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[m]))}\nfunction add(id){const x=cart.find(i=>i.product_id===id);if(x)x.quantity++;else cart.push({product_id:id,quantity:1});save();toast('Skin adicionada ao carrinho.')}\nfunction save(){localStorage.setItem('gto_cart',JSON.stringify(cart));updateCount()} function updateCount(){$('#count').textContent=cart.reduce((s,i)=>s+i.quantity,0)}\nfunction openCart(){const rows=cart.map(i=>{const p=products.find(x=>x.id===i.product_id);return p?`<div class=\"row\"><div><b>${esc(p.name)}</b><div class=\"muted\">${money(p.price)} × ${i.quantity}</div></div><button class=\"ghost\" onclick=\"removeItem('${p.id}')\">Remover</button></div>`:''}).join('');const total=cart.reduce((s,i)=>{const p=products.find(x=>x.id===i.product_id);return s+(p?Number(p.price)*i.quantity:0)},0);show(`<h2>Seu carrinho</h2>${rows||'<p class=\"muted\">Carrinho vazio.</p>'}${cart.length?`<hr><div class=\"row\"><b>Total</b><b>${money(total)}</b></div><button class=\"primary\" style=\"width:100%\" onclick=\"checkout()\">Fazer pedido</button>`:''}<br><button class=\"ghost\" onclick=\"closeModal()\">Fechar</button>`)}\nfunction removeItem(id){cart=cart.filter(i=>i.product_id!==id);save();openCart()}\nfunction checkout(){if(!cart.length)return;show(`<h2>Fazer pedido</h2><p class=\"muted\">Depois do pedido, você receberá as instruções para pagamento. A liberação da skin será feita após a confirmação.</p><input id=\"name\" placeholder=\"Seu nome\" style=\"width:100%;margin:6px 0\"><input id=\"email\" type=\"email\" placeholder=\"Seu e-mail (recomendado)\" style=\"width:100%;margin:6px 0\"><button class=\"primary\" style=\"width:100%;margin-top:10px\" onclick=\"placeOrder()\">Enviar pedido</button><br><button class=\"ghost\" onclick=\"openCart()\">Voltar</button>`)}\nasync function placeOrder(){const name=$('#name').value.trim(),email=$('#email').value.trim();if(!name)return toast('Informe seu nome.');show('<p>Enviando pedido...</p>');try{const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer_name:name,customer_email:email,items:cart})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível criar o pedido.');localStorage.setItem('gto_last_token',d.access_token);cart=[];save();show(`<h2>Pedido enviado!</h2><p>Número do pedido: <b>${esc(d.order_id)}</b></p><p>Total: <b>${money(d.total)}</b></p><p class=\"muted\">Aguarde a confirmação do pagamento pelo administrador. Depois disso, o botão de download aparecerá em “Meus pedidos”.</p><button class=\"primary\" onclick=\"openOrders()\">Acompanhar pedido</button><button class=\"ghost\" onclick=\"closeModal()\" style=\"margin-left:8px\">Fechar</button>`)}catch(e){show(`<h2>Não foi possível criar o pedido</h2><p class=\"muted\">${esc(e.message)}</p><button class=\"ghost\" onclick=\"checkout()\">Voltar</button>`)}}\nasync function openOrders(){const token=localStorage.getItem('gto_last_token');if(!token)return show('<h2>Meus pedidos</h2><p class=\"muted\">Nenhum pedido salvo neste aparelho.</p><button class=\"ghost\" onclick=\"closeModal()\">Fechar</button>');show('<p>Consultando pedido...</p>');const r=await fetch('/api/orders/'+encodeURIComponent(token));const d=await r.json();if(!r.ok)return show(`<p>${esc(d.error)}</p>`);const downloads=(d.downloads||[]).map(x=>`<a class=\"primary\" style=\"display:block;text-align:center;text-decoration:none;margin:8px 0\" href=\"${esc(x.url)}\">Baixar skin</a>`).join('');show(`<h2>Pedido</h2><p>Status: <b>${esc(d.status)}</b></p><p>Total: <b>${money(d.total)}</b></p>${d.status==='PAGO'?(downloads||'<p class=\"muted\">Pagamento confirmado, mas o arquivo ainda não foi configurado.</p>'):'<p class=\"muted\">O download será liberado após a confirmação do pagamento.</p>'}<button class=\"ghost\" onclick=\"closeModal()\">Fechar</button>`)}\nfunction show(html){$('#box').innerHTML=html;$('#modal').classList.add('open')}function closeModal(){$('#modal').classList.remove('open')}function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),2200)}\nload();";
const ADMIN_HTML = "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>GTO Skins — Admin</title><style>body{font-family:system-ui;background:#090b0d;color:#fff;max-width:1000px;margin:auto;padding:20px}input,select,textarea{background:#11171b;color:#fff;border:1px solid #263039;border-radius:8px;padding:10px;margin:4px}button{padding:10px;border:0;border-radius:8px;background:#19d37b;font-weight:800}.card{border:1px solid #263039;padding:14px;border-radius:12px;margin:10px 0;background:#12161a}.muted{color:#98a5ad}</style></head><body><h1>GTO Skins — Admin</h1><section id=\"login\"><input id=\"email\" type=\"email\" placeholder=\"E-mail\"><input id=\"pass\" type=\"password\" placeholder=\"Senha\"><button onclick=\"login()\">Entrar</button></section><section id=\"panel\" style=\"display:none\"><button onclick=\"logout()\">Sair</button><h2>Novo produto</h2><p class=\"muted\">Para liberar uma compra, altere o pedido para <b>PAGO</b>. O cliente verá o download automaticamente.</p><input id=\"name\" placeholder=\"Nome\"><input id=\"price\" type=\"number\" step=\"0.01\" placeholder=\"Preço\"><input id=\"category\" placeholder=\"Categoria\"><input id=\"image_url\" placeholder=\"URL da imagem\"><input id=\"download_path\" placeholder=\"Caminho no bucket Skins (ex: caminhao1.zip)\"><textarea id=\"description\" placeholder=\"Descrição\"></textarea><button onclick=\"createProduct()\">Cadastrar</button><h2>Pedidos</h2><div id=\"orders\"></div><h2>Produtos</h2><div id=\"products\"></div></section><script src=\"/admin.js\"></script></body></html>";
const ADMIN_JS = "let token=null;const $=s=>document.querySelector(s);function hdr(){return {Authorization:'Bearer '+token,'Content-Type':'application/json'}}\nasync function login(){try{const r=await fetch('/api/config');const c=await r.json();const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');const sb=createClient(c.supabaseUrl,c.supabasePublishableKey);const {data,error}=await sb.auth.signInWithPassword({email:$('#email').value,password:$('#pass').value});if(error)return alert(error.message);token=data.session.access_token;$('#login').style.display='none';$('#panel').style.display='block';load()}catch(e){alert(e.message)}}\nasync function load(){const [p,o]=await Promise.all([fetch('/api/products'),fetch('/api/admin/orders',{headers:hdr()})]);const products=await p.json(),orders=await o.json();if(!Array.isArray(orders))return alert(orders.error||'Erro ao carregar pedidos');$('#products').innerHTML=(products||[]).map(x=>`<div class=\"card\"><b>${esc(x.name)}</b><div class=\"muted\">${esc(x.category)} — R$ ${Number(x.price).toFixed(2)}</div><div>${esc(x.download_path||'sem arquivo')}</div></div>`).join('')||'Nenhum';$('#orders').innerHTML=(orders||[]).map(x=>`<div class=\"card\"><b>${esc(x.status)}</b> — ${esc(x.customer_name)}<div>R$ ${Number(x.total).toFixed(2)}</div><div class=\"muted\">${esc(x.customer_email||'sem e-mail')} · ${esc(x.id)}</div><select onchange=\"setStatus('${x.id}',this.value)\"><option value=\"PENDENTE\" ${x.status==='PENDENTE'?'selected':''}>PENDENTE</option><option value=\"PAGO\" ${x.status==='PAGO'?'selected':''}>PAGO — liberar download</option><option value=\"CANCELADO\" ${x.status==='CANCELADO'?'selected':''}>CANCELADO</option><option value=\"ESTORNADO\" ${x.status==='ESTORNADO'?'selected':''}>ESTORNADO</option></select></div>`).join('')||'Nenhum'}\nasync function setStatus(id,status){const r=await fetch('/api/admin/orders/'+id,{method:'PATCH',headers:hdr(),body:JSON.stringify({status})});const d=await r.json();if(!r.ok)alert(d.error);else load()}\nasync function createProduct(){const body={name:$('#name').value,price:$('#price').value,category:$('#category').value||'Caminhões',image_url:$('#image_url').value,download_path:$('#download_path').value,description:$('#description').value};const r=await fetch('/api/admin/products',{method:'POST',headers:hdr(),body:JSON.stringify(body)});const d=await r.json();if(!r.ok)return alert(d.error);alert('Produto cadastrado');load()}\nfunction esc(s){return String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[m]))}function logout(){location.reload()}";

app.get('/app.js', (_req, res) => { res.type('application/javascript').send(APP_JS); });
app.get('/admin', (_req, res) => { res.type('html').send(ADMIN_HTML); });
app.get('/admin/', (_req, res) => { res.type('html').send(ADMIN_HTML); });
app.get('/admin.js', (_req, res) => { res.type('application/javascript').send(ADMIN_JS); });
app.get('/', (_req, res) => { res.type('html').send(INDEX_HTML); });
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/admin')) return res.type('html').send(INDEX_HTML);
  next();
});

app.listen(PORT, () => console.log(`GTO Skins rodando em ${APP_URL}`));
