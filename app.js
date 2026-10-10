/* ツーリングルート — 試作版
 * 流れ：地図をタップして経由地を置く → 道路に沿ったルートを計算 → 保存
 *       → 「出発」で Googleマップに経由地付きで渡す（9件ごとに区間分け）
 */
'use strict';

// ===== 設定 =====
const MAX_WAYPOINTS_PER_LINK = 9;       // Googleマップに1回で渡せる経由地の数（出発地・目的地を除く）
// ルート計算：Valhalla（FOSSGIS の無料公開サーバー）。バイク用の設定と有料道路の回避に対応
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
// 予備：OSRM（有料道路の回避はできない）
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const STORE_ROUTES = 'touring.routes.v1';
const STORE_DRAFT = 'touring.draft.v1';
const STORE_VIEW = 'touring.view.v1';

const LAYERS = [
  { name: '地理院地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', max: 18,
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' },
  { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19,
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
  { name: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', max: 18,
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' },
];

// ===== 状態 =====
const state = {
  id: null,            // 保存済みルートのID（未保存なら null）
  name: '',
  points: [],          // [{lat, lng}] 0番目=出発地、最後=目的地
  avoidTolls: true,
  legs: [],            // ルート計算結果：経由地間ごとの {coords, distance, duration, toll}
  history: [],         // 「戻す」用
  dirty: false,        // 保存後に変更があるか
};
let routeRequestSeq = 0;
let routeTimer = null;

// ===== 小道具 =====
const $ = (sel) => document.querySelector(sel);
const storage = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 保存できない環境では無視 */ } },
};
let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
function fmtTime(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分`;
}
const ll = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
// 2点間の距離（メートル）
function dist(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ===== 地図 =====
const savedView = storage.get(STORE_VIEW, { center: [35.36, 138.73], zoom: 9 }); // 初期表示：富士山周辺
const map = L.map('map', { zoomControl: false, tap: true }).setView(savedView.center, savedView.zoom);
let layerIndex = 0;
let baseLayer = L.tileLayer(LAYERS[0].url, { maxZoom: LAYERS[0].max, attribution: LAYERS[0].attr }).addTo(map);
map.on('moveend', () => storage.set(STORE_VIEW, { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }));

const routeGroup = L.layerGroup().addTo(map);   // ルートの線
const markerGroup = L.layerGroup().addTo(map);  // 経由地マーカー
let meMarker = null;

// 地図をタップ → 経由地を末尾に追加
map.on('click', (e) => {
  pushHistory();
  state.points.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  changed();
});

// ===== 描画 =====
function renderMarkers() {
  markerGroup.clearLayers();
  const n = state.points.length;
  state.points.forEach((p, i) => {
    const cls = i === 0 ? 'start' : (i === n - 1 && n > 1 ? 'goal' : '');
    const label = i === 0 ? 'S' : (i === n - 1 && n > 1 ? 'G' : String(i));
    const icon = L.divIcon({ className: '', html: `<div class="wp ${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    const m = L.marker([p.lat, p.lng], { icon, draggable: true, autoPan: true }).addTo(markerGroup);
    m.on('dragstart', () => pushHistory());
    m.on('dragend', () => {
      const pos = m.getLatLng();
      state.points[i] = { lat: pos.lat, lng: pos.lng };
      changed();
    });
    const box = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = i === 0 ? '出発地' : (i === n - 1 && n > 1 ? '目的地' : `経由地 ${i}`);
    title.style.cssText = 'font-weight:700;margin-bottom:8px;color:#111';
    const del = document.createElement('button');
    del.className = 'popup-btn';
    del.textContent = '削除';
    del.onclick = () => { pushHistory(); state.points.splice(i, 1); map.closePopup(); changed(); };
    box.append(title, del);
    m.bindPopup(box);
  });
}

function renderRoute() {
  routeGroup.clearLayers();
  state.legs.forEach((leg, i) => {
    if (!leg.coords.length) return;
    L.polyline(leg.coords, { color: '#000', weight: 9, opacity: 0.35, interactive: false }).addTo(routeGroup);
    L.polyline(leg.coords, { color: leg.toll ? '#ffcc4d' : '#ff7a1a', weight: 6, opacity: 0.95, interactive: false }).addTo(routeGroup);
    // 太い透明の線：タップしやすくするため。線をタップするとその区間に経由地を挿入
    const hit = L.polyline(leg.coords, { color: '#000', weight: 28, opacity: 0, bubblingMouseEvents: false }).addTo(routeGroup);
    hit.on('click', (e) => {
      pushHistory();
      state.points.splice(i + 1, 0, { lat: e.latlng.lat, lng: e.latlng.lng });
      changed();
      toast('経由地を挿入しました。ドラッグで調整できます');
    });
  });
}

function renderStats() {
  const d = state.legs.reduce((s, l) => s + l.distance, 0);
  const t = state.legs.reduce((s, l) => s + l.duration, 0);
  $('#stat-dist').textContent = state.legs.length ? fmtKm(d) : '--';
  $('#stat-time').textContent = state.legs.length ? fmtTime(t) : '--';
  $('#stat-points').textContent = state.points.length;
  $('#toll-badge').hidden = !state.legs.some((l) => l.toll);
  $('#btn-start').disabled = state.points.length < 2;
  $('#btn-undo').disabled = state.history.length === 0;
  $('#avoid-tolls').checked = state.avoidTolls;
  if (document.activeElement !== $('#route-name')) $('#route-name').value = state.name;
}

function renderAll() { renderMarkers(); renderRoute(); renderStats(); }

// ===== 変更処理 =====
function pushHistory() {
  state.history.push(state.points.map((p) => ({ ...p })));
  if (state.history.length > 50) state.history.shift();
}

function changed() {
  state.dirty = true;
  // 経由地の数が変わったら古い線はずれるので一旦消す
  if (state.legs.length !== Math.max(0, state.points.length - 1)) state.legs = [];
  renderAll();
  saveDraft();
  clearTimeout(routeTimer);
  routeTimer = setTimeout(computeRoute, 700);  // 公開サーバーに負担をかけないよう少し待ってから計算
}

function saveDraft() {
  storage.set(STORE_DRAFT, { id: state.id, name: state.name, points: state.points, avoidTolls: state.avoidTolls, dirty: state.dirty });
}

// ===== ルート計算 =====
// Valhalla が返す線（polyline6 形式の文字列）を [[lat, lng], ...] に変換
function decodePolyline6(str) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    coords.push([lat / 1e6, lng / 1e6]);
  }
  return coords;
}

// 結果は共通の形 { legs: [{coords, distance(m), duration(秒), toll}], snapped: [{lat,lng}] } にそろえる
async function routeValhalla(points, avoidTolls) {
  const body = {
    locations: points.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6) })),
    costing: 'motorcycle',
    costing_options: { motorcycle: avoidTolls ? { exclude_tolls: true } : {} },
    directions_type: 'none',
  };
  // Content-Type を付けないのがポイント（付けるとブラウザの事前確認が入り、失敗しやすい）
  const res = await fetch(VALHALLA_URL, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.trip) throw new Error(data.error || `HTTP ${res.status}`);
  const legs = data.trip.legs.map((leg) => ({
    coords: decodePolyline6(leg.shape),
    distance: leg.summary.length * 1000,
    duration: leg.summary.time,
    toll: !!leg.summary.has_toll,
  }));
  // 各区間の線の始点＝道路に吸着した経由地の位置
  const snapped = legs.map((l) => ({ lat: l.coords[0][0], lng: l.coords[0][1] }));
  const last = legs[legs.length - 1].coords;
  snapped.push({ lat: last[last.length - 1][0], lng: last[last.length - 1][1] });
  return { legs, snapped };
}

async function routeOsrm(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const res = await fetch(`${OSRM_URL}${coords}?overview=false&steps=true&geometries=geojson`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 'Ok') throw new Error(data.message || data.code || `HTTP ${res.status}`);
  const legs = data.routes[0].legs.map((leg) => {
    const c = [];
    let toll = false;
    for (const st of leg.steps) {
      for (const xy of st.geometry.coordinates) c.push([xy[1], xy[0]]);
      if (st.intersections && st.intersections.some((x) => x.classes && x.classes.includes('toll'))) toll = true;
    }
    return { coords: c, distance: leg.distance, duration: leg.duration, toll };
  });
  return { legs, snapped: data.waypoints.map((w) => ({ lat: w.location[1], lng: w.location[0] })) };
}

async function computeRoute() {
  if (state.points.length < 2) { state.legs = []; renderAll(); return; }
  const seq = ++routeRequestSeq;
  const points = state.points.map((p) => ({ ...p }));
  let result = null, usedFallback = false;

  try {
    result = await routeValhalla(points, state.avoidTolls);
  } catch (e) {
    console.warn('Valhalla失敗', e);
    if (seq !== routeRequestSeq) return;
    try { result = await routeOsrm(points); usedFallback = true; }
    catch (e2) { console.warn('OSRM失敗', e2); }
  }
  if (seq !== routeRequestSeq) return;  // 計算中に別の変更があった
  if (!result) { toast('ルートを計算できませんでした。少し待ってから経由地を動かしてみてください', 3500); return; }
  if (usedFallback && state.avoidTolls) toast('予備のサーバーで計算しました（有料道路の回避は効いていません）', 3500);

  state.legs = result.legs;
  // 経由地を道路の上に吸着（Googleマップに渡したときのズレを減らす）
  result.snapped.forEach((s, i) => {
    if (!state.points[i]) return;
    const d = dist(state.points[i], s);
    if (d > 3 && d < 500) state.points[i] = s;
  });
  saveDraft();
  renderAll();
}

// ===== 保存・一覧 =====
function loadRoutes() { return storage.get(STORE_ROUTES, []); }
function saveRoutes(list) { storage.set(STORE_ROUTES, list); }

function saveCurrent() {
  if (state.points.length < 2) { toast('出発地と目的地を置いてから保存してください'); return; }
  const name = ($('#route-name').value || '').trim() || defaultName();
  state.name = name;
  const list = loadRoutes();
  const total = state.legs.reduce((s, l) => s + l.distance, 0);
  const item = {
    id: state.id || String(Date.now()),
    name, points: state.points, avoidTolls: state.avoidTolls,
    distance: total, updatedAt: Date.now(),
  };
  const idx = list.findIndex((r) => r.id === item.id);
  if (idx >= 0) list[idx] = item; else list.push(item);
  saveRoutes(list);
  state.id = item.id;
  state.dirty = false;
  saveDraft();
  renderStats();
  toast(`「${name}」を保存しました`);
}

function defaultName() {
  const d = new Date();
  return `ルート ${d.getMonth() + 1}/${d.getDate()}`;
}

function openRoute(r) {
  state.id = r.id;
  state.name = r.name;
  state.points = r.points.map((p) => ({ ...p }));
  state.avoidTolls = r.avoidTolls !== false;
  state.legs = [];
  state.history = [];
  state.dirty = false;
  renderAll();
  saveDraft();
  fitRoute();
  computeRoute();
}

function fitRoute() {
  if (state.points.length) map.fitBounds(L.latLngBounds(state.points.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 15 });
}

function renderList() {
  const ul = $('#route-list');
  ul.innerHTML = '';
  const list = loadRoutes().sort((a, b) => b.updatedAt - a.updatedAt);
  $('#route-list-empty').hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    const b = document.createElement('b'); b.textContent = r.name;
    const s = document.createElement('small');
    const d = new Date(r.updatedAt);
    s.textContent = `${r.distance ? fmtKm(r.distance) + '・' : ''}経由地${r.points.length}・${d.getMonth() + 1}/${d.getDate()}更新`;
    open.append(b, s);
    open.onclick = () => {
      if (state.dirty && state.points.length && !confirm('編集中のルートは保存されていません。開きますか？')) return;
      openRoute(r); closeSheets();
    };
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '削除';
    del.onclick = () => {
      if (!confirm(`「${r.name}」を削除しますか？`)) return;
      saveRoutes(loadRoutes().filter((x) => x.id !== r.id));
      if (state.id === r.id) { state.id = null; state.dirty = true; saveDraft(); }
      renderList();
    };
    li.append(open, del);
    ul.append(li);
  }
}

// ===== Googleマップへ渡す =====
// 経由地の番号を [開始, 終了] の区間に分ける（1区間あたり 出発地＋経由地9件＋目的地）
function splitLegs(n) {
  const out = [];
  for (let s = 0; s < n - 1; s += MAX_WAYPOINTS_PER_LINK + 1) out.push([s, Math.min(s + MAX_WAYPOINTS_PER_LINK + 1, n - 1)]);
  return out;
}

function googleLinks(origin, mids, dest) {
  // 公式のURL形式（iPhoneでGoogleマップアプリが入っていればアプリで開く）
  const params = new URLSearchParams({ api: '1', destination: ll(dest), travelmode: 'driving', dir_action: 'navigate' });
  if (origin) params.set('origin', ll(origin));
  if (mids.length) params.set('waypoints', mids.map(ll).join('|'));
  const web = `https://www.google.com/maps/dir/?${params.toString()}`;
  // iPhoneのGoogleマップアプリを直接開く形式（予備）
  const daddr = mids.concat([dest]).map(ll).join('+to:');
  const app = `comgooglemaps://?${origin ? `saddr=${ll(origin)}&` : ''}daddr=${daddr}&directionsmode=driving`;
  return { web, app };
}

function openStartSheet() {
  if (state.points.length < 2) return;
  const n = state.points.length;
  const ranges = splitLegs(n);
  const ul = $('#leg-list');
  ul.innerHTML = '';
  ranges.forEach(([s, e], k) => {
    const pts = state.points;
    const { web, app } = googleLinks(pts[s], pts.slice(s + 1, e), pts[e]);
    const legs = state.legs.slice(s, e);
    const d = legs.reduce((sum, l) => sum + l.distance, 0);
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'leg-info';
    const from = s === 0 ? '出発地' : `経由地${s}`;
    const to = e === n - 1 ? '目的地' : `経由地${e}`;
    info.innerHTML = `<b>区間${k + 1}</b><small></small>`;
    info.querySelector('small').textContent = `${from} → ${to}${legs.length === e - s ? '・' + fmtKm(d) : ''}`;
    const go = document.createElement('a'); go.className = 'go'; go.href = web; go.target = '_blank'; go.rel = 'noopener'; go.textContent = '開く';
    const alt = document.createElement('a'); alt.className = 'alt'; alt.href = app; alt.textContent = 'アプリで開く';
    li.append(info, go, alt);
    ul.append(li);
  });

  // 有料道路についての注意
  $('#resume-link').hidden = true;
  $('#btn-resume').hidden = false;
  const hasToll = state.legs.some((l) => l.toll);
  const warn = $('#start-warning');
  if (hasToll && state.avoidTolls) {
    warn.hidden = false;
    warn.textContent = '有料道路を避けて計算しましたが、避けられない有料区間（黄色の線）が残っています。経由地を動かすか、「有料道路を避ける」をオフにしてください。';
  } else if (hasToll) {
    warn.hidden = false;
    warn.textContent = 'このルートには有料区間（黄色の線）が含まれます。Googleマップの「ルートオプション」で「有料道路を使用しない」をオフにしてから出発してください。';
  } else if (state.avoidTolls) {
    warn.hidden = false;
    warn.textContent = 'Googleマップ側の「ルートオプション」で「有料道路を使用しない」をオンにしておくと、このルートと同じ道で案内されやすくなります。';
  } else {
    warn.hidden = true;
  }
  showSheet('#sheet-start');
}

// 現在地から続きを案内：今いる位置に一番近い区間を探し、その先の経由地を渡す
function resumeFromHere() {
  if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return; }
  toast('現在地を取得中…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    let bestLeg = 0, best = Infinity;
    if (state.legs.length === state.points.length - 1 && state.legs.length) {
      state.legs.forEach((leg, i) => {
        for (const c of leg.coords) {
          const d = dist(here, { lat: c[0], lng: c[1] });
          if (d < best) { best = d; bestLeg = i; }
        }
      });
    } else {
      // ルート線がない場合は、一番近い経由地の次から
      state.points.forEach((p, i) => { const d = dist(here, p); if (d < best) { best = d; bestLeg = Math.min(i, state.points.length - 2); } });
    }
    const remaining = state.points.slice(bestLeg + 1);
    const take = remaining.slice(0, MAX_WAYPOINTS_PER_LINK + 1);
    const dest = take[take.length - 1];
    const { web } = googleLinks(null, take.slice(0, -1), dest);
    const left = remaining.length - take.length;
    const lastNo = bestLeg + take.length;
    const link = $('#resume-link');
    link.href = web;
    link.textContent = left > 0 ? `Googleマップを開く（経由地${lastNo}まで）` : 'Googleマップを開く（ゴールまで）';
    link.hidden = false;
    $('#btn-resume').hidden = true;
    if (left > 0) toast('残りの経由地は、着いたらもう一度「続きを案内」で', 4000);
  }, () => toast('現在地を取得できませんでした。位置情報の許可を確認してください', 3500),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

// ===== 共有（URLにルートを埋め込む）=====
function encodeShare() {
  const payload = { n: state.name || '', t: state.avoidTolls ? 1 : 0, p: state.points.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5)]) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeShare(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(escape(atob(b64)));
  const o = JSON.parse(json);
  return { name: String(o.n || ''), avoidTolls: o.t !== 0, points: (o.p || []).map(([lat, lng]) => ({ lat, lng })) };
}
async function shareRoute() {
  const url = `${location.origin}${location.pathname}#r=${encodeShare()}`;
  const title = state.name || 'ツーリングルート';
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('共有用URLをコピーしました');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    prompt('このURLをコピーして送ってください', url);
  }
}

// ===== シート =====
function showSheet(sel) { $(sel).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true)); }
document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) closeSheets(); });
});

// ===== ボタン =====
$('#btn-undo').onclick = () => {
  if (!state.history.length) return;
  state.points = state.history.pop();
  state.legs = [];
  changed();
};
$('#btn-reverse').onclick = () => {
  if (state.points.length < 2) return;
  pushHistory(); state.points.reverse(); state.legs = []; changed(); toast('出発地と目的地を入れ替えました');
};
$('#btn-save').onclick = saveCurrent;
$('#btn-start').onclick = openStartSheet;
$('#btn-resume').onclick = resumeFromHere;
$('#btn-share').onclick = shareRoute;
$('#btn-list').onclick = () => { renderList(); showSheet('#sheet-list'); };
$('#btn-new').onclick = () => {
  if (state.dirty && state.points.length && !confirm('編集中のルートは保存されていません。新しく作りますか？')) return;
  Object.assign(state, { id: null, name: '', points: [], legs: [], history: [], dirty: false });
  renderAll(); saveDraft();
  toast('地図をタップして出発地を置いてください');
};
$('#avoid-tolls').onchange = (e) => { state.avoidTolls = e.target.checked; changed(); };
$('#route-name').addEventListener('input', (e) => { state.name = e.target.value; state.dirty = true; saveDraft(); });
$('#route-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('#btn-layer').onclick = () => {
  layerIndex = (layerIndex + 1) % LAYERS.length;
  const L0 = LAYERS[layerIndex];
  map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(L0.url, { maxZoom: L0.max, attribution: L0.attr }).addTo(map);
  toast(L0.name);
};

$('#btn-locate').onclick = () => {
  if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    const p = [pos.coords.latitude, pos.coords.longitude];
    if (meMarker) meMarker.setLatLng(p);
    else meMarker = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(map);
    map.setView(p, Math.max(map.getZoom(), 13));
  }, () => toast('現在地を取得できませんでした'), { enableHighAccuracy: true, timeout: 15000 });
};

// ===== 起動 =====
(function init() {
  // 共有URLから開いた場合
  const m = location.hash.match(/#r=([\w-]+)/);
  if (m) {
    try {
      const r = decodeShare(m[1]);
      Object.assign(state, { id: null, name: r.name, points: r.points, avoidTolls: r.avoidTolls, legs: [], history: [], dirty: true });
      history.replaceState(null, '', location.pathname);
      renderAll(); saveDraft(); fitRoute(); computeRoute();
      toast('共有されたルートを開きました。「保存」で一覧に追加できます', 4000);
      return;
    } catch (e) { console.warn(e); toast('共有URLを読み込めませんでした'); }
  }
  // 前回の編集途中の状態を復元
  const d = storage.get(STORE_DRAFT, null);
  if (d && d.points && d.points.length) {
    Object.assign(state, { id: d.id || null, name: d.name || '', points: d.points, avoidTolls: d.avoidTolls !== false, dirty: !!d.dirty });
    renderAll(); computeRoute();
  } else {
    renderAll();
    toast('地図をタップして出発地を置いてください', 3500);
  }
})();
