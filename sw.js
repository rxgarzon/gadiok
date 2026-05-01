// ══════════════════════════════════════════════════════════════
// DISFER POS — Service Worker con Background Sync
// ══════════════════════════════════════════════════════════════

const CACHE_NAME = 'disfer-pos-v1';

// ── Instalación: cachear recursos principales ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([
        '/gadiok/index.html',
        '/gadiok/manifest.json',
        '/gadiok/icon-192.png',
        '/gadiok/icon-512.png'
      ]).catch(() => {}) // Si alguno falla no detiene la instalación
    )
  );
  self.skipWaiting();
});

// ── Activación: limpiar caches viejos ─────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: responder con cache si no hay red ──────────────────
self.addEventListener('fetch', event => {
  // Solo cachear recursos propios (no Supabase ni CDNs)
  if (!event.request.url.includes('/gadiok/')) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        // Actualizar cache con la versión más reciente
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    }).catch(() => caches.match('/gadiok/index.html'))
  );
});

// ══════════════════════════════════════════════════════════════
// BACKGROUND SYNC — sincronizar pendientes aunque la app esté cerrada
// ══════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'sync-pendientes') {
    event.waitUntil(sincronizarPendientes());
  }
});

async function sincronizarPendientes() {
  // Abrir IndexedDB
  const db = await abrirIDB();
  const stores = ['ventas_q', 'creditos_q', 'abonos_q', 'clientes_q'];

  // Verificar si hay pendientes
  let totalPendientes = 0;
  for (const store of stores) {
    const items = await getAllFromStore(db, store);
    totalPendientes += items.length;
  }

  if (totalPendientes === 0) return;

  // Notificar a la app que el SW está sincronizando
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SW_SYNC_START', total: totalPendientes }));

  // Obtener configuración de Supabase desde IDB
  const config = await getFromStore(db, 'config', 'sb_config');
  if (!config?.url || !config?.key) {
    // Sin config no podemos sincronizar, la app lo hará cuando se abra
    return;
  }

  const { url: SB_URL, key: SB_KEY } = config;
  let sincronizados = 0;

  // ── Clientes ────────────────────────────────────────────────
  const clientes = await getAllFromStore(db, 'clientes_q');
  for (const c of clientes) {
    const { uid: _u, ...row } = c;
    const ok = await upsertSupa(SB_URL, SB_KEY, 'clientes', row, 'uuid_local');
    if (ok) { await delFromStore(db, 'clientes_q', c.uid); lsBackupDelSW('clientes_q', c.uid); sincronizados++; }
  }

  // ── Ventas ──────────────────────────────────────────────────
  const ventas = await getAllFromStore(db, 'ventas_q');
  for (const v of ventas) {
    const { uid: _u, ...row } = v;
    // Asignar folio si está vacío
    if (!row.folio) {
      const folio = await incrementarFolioSupa(SB_URL, SB_KEY, 'VTA');
      if (folio) row.folio = folio;
    }
    const ok = await upsertSupa(SB_URL, SB_KEY, 'ventas', row, 'uuid_local');
    if (ok) { await delFromStore(db, 'ventas_q', v.uid); lsBackupDelSW('ventas_q', v.uid); sincronizados++; }
  }

  // ── Créditos ────────────────────────────────────────────────
  const creditos = await getAllFromStore(db, 'creditos_q');
  for (const c of creditos) {
    const { uid: _u, ...row } = c;
    const ok = await upsertSupa(SB_URL, SB_KEY, 'creditos', row, 'uuid_local');
    if (ok) { await delFromStore(db, 'creditos_q', c.uid); lsBackupDelSW('creditos_q', c.uid); sincronizados++; }
  }

  // ── Abonos ──────────────────────────────────────────────────
  const abonos = await getAllFromStore(db, 'abonos_q');
  for (const a of abonos) {
    const { uid: _u, ...row } = a;
    if (!row.folio) {
      const folio = await incrementarFolioSupa(SB_URL, SB_KEY, 'ABO');
      if (folio) row.folio = folio;
    }
    const ok = await upsertSupa(SB_URL, SB_KEY, 'abonos', row, 'uuid_local');
    if (ok) {
      await delFromStore(db, 'abonos_q', a.uid);
      // Actualizar saldo del crédito
      if (a.credito_uuid) {
        await fetch(`${SB_URL}/rest/v1/creditos?uuid_local=eq.${a.credito_uuid}`, {
          method: 'PATCH',
          headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ saldo_pendiente: a.saldo_restante, liquidado: a.saldo_restante <= 0, estatus: a.saldo_restante <= 0 ? 'CERRADO' : 'ABIERTO' })
        }).catch(() => {});
      }
      sincronizados++;
    }
  }

  // Notificar a la app cuántos se sincronizaron
  const clients2 = await self.clients.matchAll();
  clients2.forEach(client => client.postMessage({ type: 'SW_SYNC_DONE', sincronizados }));
}

// ── Helpers Supabase REST ──────────────────────────────────────
async function upsertSupa(url, key, table, row, conflict) {
  try {
    const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(row)
    });
    return res.ok || res.status === 409;
  } catch { return false; }
}

async function incrementarFolioSupa(url, key, tipo) {
  try {
    const res = await fetch(`${url}/rest/v1/rpc/incrementar_folio`, {
      method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_tipo: tipo })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return tipo + '-' + String(data).padStart(4, '0');
  } catch { return null; }
}

// ── Helpers localStorage desde SW ─────────────────────────────
function lsBackupDelSW(store, key) {
  // El SW no tiene acceso a localStorage directamente,
  // notifica a los clientes para que limpien ellos
  self.clients.matchAll().then(clients =>
    clients.forEach(c => c.postMessage({ type: 'LS_BACKUP_DEL', store, key }))
  );
}

// ── Helpers IndexedDB desde SW ────────────────────────────────
function abrirIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('disfer_v5', 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllFromStore(db, store) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

function getFromStore(db, store, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function delFromStore(db, store, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}
