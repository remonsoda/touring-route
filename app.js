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
  selected: null,      // 選択中の経由地の番号（なし＝null）
  mainRoad: true,      // 大通りを優先（タップした経由地を県道クラス以上に吸着）
  legs: [],            // ルート計算結果：経由地間ごとの {coords, distance, duration, toll}
  history: [],         // 「戻す」用
  dirty: false,        // 保存後に変更があるか
};
let routeRequestSeq = 0;
let routeTimer = null;
let suppressClickUntil = 0;
// 経由地バッジの表示モード（スクショ用に小さく・隠すことができる）
const MARKER_MODES = ['full', 'small', 'ends'];
const MARKER_MODE_LABEL = { full: '経由地：通常表示', small: '経由地：小さく表示', ends: '経由地：出発地と目的地だけ' };
let markerMode = 'full';
try { markerMode = localStorage.getItem('touring.markerMode') || 'full'; } catch { /* 無視 */ }

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
// 地図の枠の大きさが変わったら Leaflet に知らせる。
// これがないと、下のパネルの高さが変わったときなどに地図の一部しか読み込まれない
if ('ResizeObserver' in window) {
  new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById('map'));
}
window.addEventListener('load', () => map.invalidateSize({ pan: false }));
// なぞるボタンを下のパネルのすぐ上に置く
const panelEl = document.querySelector('.panel');
const placeSketchBtn = () => document.documentElement.style.setProperty('--panel-h', panelEl.offsetHeight + 'px');
if ('ResizeObserver' in window) new ResizeObserver(placeSketchBtn).observe(panelEl);
placeSketchBtn();
map.on('moveend', () => storage.set(STORE_VIEW, { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }));

const routeGroup = L.layerGroup().addTo(map);   // ルートの線
const markerGroup = L.layerGroup().addTo(map);  // 経由地マーカー
let meMarker = null;

// 地図をタップ → 経由地を末尾に追加
// （経由地を選択中なら、まず選択を解除するだけ。うっかり追加を防ぐ）
map.on('click', (e) => {
  if (Date.now() < suppressClickUntil) return;   // なぞり終わり直後のクリックは無視
  if (state.selected !== null) { state.selected = null; map.closePopup(); renderMarkers(); return; }
  pushHistory();
  state.points.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  changed();
});

// ===== 描画 =====
// 経由地は「タップで選択 → 選択中のものだけドラッグで動かせる」。
// 地図をずらそうとして経由地に触れても、勝手に動かないようにするため。
function renderMarkers() {
  markerGroup.clearLayers();
  const n = state.points.length;
  let lastShownPx = null;
  state.points.forEach((p, i) => {
    const selected = state.selected === i;
    const isEnd = i === 0 || (i === n - 1 && n > 1);
    // 表示モード：full＝通常（込み合う所だけ小さく）／small＝全部小さな点／ends＝出発地と目的地だけ
    if (markerMode === 'ends' && !isEnd && !selected) return;
    const px = map.latLngToContainerPoint([p.lat, p.lng]);
    const crowded = lastShownPx && px.distanceTo(lastShownPx) < 36;
    const small = !selected && (markerMode === 'small' || (crowded && !isEnd));
    lastShownPx = px;
    const cls = (i === 0 ? 'start' : (i === n - 1 && n > 1 ? 'goal' : '')) + (selected ? ' selected' : '') + (small ? ' small' : '');
    const label = small ? '' : (i === 0 ? 'S' : (i === n - 1 && n > 1 ? 'G' : String(i)));
    const size = selected ? 40 : (small ? (isEnd ? 16 : 12) : 30);
    const icon = L.divIcon({ className: '', html: `<div class="wp ${cls}">${label}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const m = L.marker([p.lat, p.lng], { icon, draggable: selected, autoPan: true, zIndexOffset: selected ? 1000 : 0 }).addTo(markerGroup);
    if (selected) {
      m.on('dragstart', () => { pushHistory(); map.closePopup(); });
      m.on('dragend', () => {
        const pos = m.getLatLng();
        state.points[i] = { lat: pos.lat, lng: pos.lng, exact: true };
        changed();
      });
    }
    m.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.selected !== i) { state.selected = i; renderMarkers(); toast('選択中：ドラッグで移動できます'); }
      openMarkerPopup(i);
    });
  });
}

function openMarkerPopup(i) {
  const n = state.points.length, p = state.points[i];
  const box = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = i === 0 ? '出発地' : (i === n - 1 && n > 1 ? '目的地' : `経由地 ${i}`);
  title.style.cssText = 'font-weight:700;margin-bottom:8px;color:#111';
  const del = document.createElement('button');
  del.className = 'popup-btn';
  del.textContent = '削除';
  del.onclick = () => { pushHistory(); state.points.splice(i, 1); state.selected = null; map.closePopup(); changed(); };
  box.append(title, del);
  L.popup({ offset: [0, -16], autoPan: false }).setLatLng([p.lat, p.lng]).setContent(box).openOn(map);
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
      if (Date.now() < suppressClickUntil) return;
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
  $('#main-road').checked = state.mainRoad;
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
  if (state.selected !== null && state.selected >= state.points.length) state.selected = null;
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
// opts.mainRoad: 経由地を県道クラス以上の道に吸着させる
// opts.noUturn : 経由地でのUターンを禁止（わき道に入って戻ってくる「ぐるぐる」を防ぐ）
async function routeValhalla(points, avoidTolls, opts = {}) {
  // 地図を広く表示しているほど、タップ位置はおおざっぱなので吸着の範囲を広げる
  const metersPerPixel = 40075016 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  const radius = Math.round(Math.min(800, Math.max(60, metersPerPixel * 30)));
  const body = {
    locations: points.map((p, i) => {
      const loc = { lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6) };
      // ドラッグで細かく置いた経由地（exact）は、狙った道をそのまま使う
      if (opts.mainRoad && !p.exact) { loc.radius = radius; loc.search_filter = { min_road_class: 'tertiary' }; }
      if (opts.noUturn && i > 0 && i < points.length - 1) loc.type = 'break_through';
      return loc;
    }),
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

// 公開サーバーは1回に送れる地点数に上限があるため、多いときは20地点ずつに分けて順番に計算してつなぐ
const MAX_LOCATIONS_PER_REQUEST = 20;
async function routeValhallaChunked(points, avoidTolls, opts, seq) {
  if (points.length <= MAX_LOCATIONS_PER_REQUEST) return routeValhalla(points, avoidTolls, opts);
  const legs = [], snapped = [];
  for (let s = 0; s < points.length - 1; s += MAX_LOCATIONS_PER_REQUEST - 1) {
    if (seq !== routeRequestSeq) throw new Error('canceled');
    if (s > 0) await new Promise((r) => setTimeout(r, 1100));  // 1秒に1回まで
    const part = await routeValhalla(points.slice(s, s + MAX_LOCATIONS_PER_REQUEST), avoidTolls, opts);
    legs.push(...part.legs);
    snapped.push(...(s === 0 ? part.snapped : part.snapped.slice(1)));
  }
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
    result = await routeValhallaChunked(points, state.avoidTolls, { mainRoad: state.mainRoad, noUturn: true }, seq);
  } catch (e) {
    console.warn('Valhalla失敗', e);
    // 行き止まりの展望台など、Uターン禁止では行けない場所がある場合は条件をゆるめて再計算
    if (seq !== routeRequestSeq) return;
    await new Promise((r) => setTimeout(r, 1100));
    try { result = await routeValhallaChunked(points, state.avoidTolls, { mainRoad: false, noUturn: false }, seq); }
    catch (e2) { console.warn('Valhalla再計算も失敗', e2); }
  }
  if (!result) {
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
    if (d > 3 && d < 1000) state.points[i] = { ...s, ...(state.points[i].exact ? { exact: true } : {}) };
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
  state.selected = null;
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

// ===== なぞってルートを作る =====
// iPhone：「なぞる」ボタンを押している間、もう1本の指で地図をなぞる（短くタップすると固定ON/OFF）
// PC   ：Ctrl（または Shift）を押しながらドラッグ
const sketch = {
  held: false,        // ボタンを押している間
  latched: false,     // 短くタップして固定ONにした状態
  ctrl: false,        // PCで Ctrl/Shift を押している間
  drawing: false,
  touchId: null,
  pts: [],            // なぞった点 [{lat,lng}]
  lastPx: null,
  line: null,
};
const sketchBtn = $('#btn-sketch');
function sketchActive() { return sketch.held || sketch.latched || sketch.ctrl; }
function updateSketchMode() {
  const on = sketchActive();
  sketchBtn.classList.toggle('on', on);
  sketchBtn.classList.toggle('latched', sketch.latched);
  document.getElementById('map').classList.toggle('drawing', on);
  // なぞっている間は地図を動かさない（ボタンを離せば元通り）
  for (const h of [map.dragging, map.touchZoom, map.doubleClickZoom, map.boxZoom]) on ? h.disable() : h.enable();
}

// ボタン：押している間だけ有効。250ms未満の短いタップで固定ON/OFF
let sketchPressAt = 0, sketchDrewDuringPress = false;
sketchBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sketchPressAt = Date.now(); sketchDrewDuringPress = false;
  sketch.held = true; updateSketchMode();
});
const releaseSketchBtn = (e) => {
  if (!sketch.held) return;
  e && e.preventDefault();
  sketch.held = false;
  if (Date.now() - sketchPressAt < 250 && !sketchDrewDuringPress) {
    sketch.latched = !sketch.latched;
    toast(sketch.latched ? 'なぞるモードON（もう一度タップでOFF）' : 'なぞるモードOFF');
  }
  if (sketch.drawing && !sketch.latched) finishStroke();
  updateSketchMode();
};
sketchBtn.addEventListener('pointerup', releaseSketchBtn);
sketchBtn.addEventListener('pointercancel', releaseSketchBtn);
sketchBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// PC：Ctrl / Shift
window.addEventListener('keydown', (e) => { if ((e.key === 'Control' || e.key === 'Shift') && !sketch.ctrl && document.activeElement.tagName !== 'INPUT') { sketch.ctrl = true; updateSketchMode(); } });
window.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Shift') { sketch.ctrl = false; if (sketch.drawing) finishStroke(); updateSketchMode(); } });
window.addEventListener('blur', () => { sketch.ctrl = false; updateSketchMode(); });

function strokeStart(clientPt) {
  sketch.drawing = true; sketchDrewDuringPress = true;
  sketch.pts = []; sketch.lastPx = null;
  if (sketch.line) map.removeLayer(sketch.line);
  sketch.line = L.polyline([], { color: '#2f8cff', weight: 5, opacity: 0.9, dashArray: '8 8', interactive: false }).addTo(map);
  strokeMove(clientPt);
}
function strokeMove(clientPt) {
  const cp = map.mouseEventToContainerPoint(clientPt);
  if (sketch.lastPx && cp.distanceTo(sketch.lastPx) < 5) return;  // 細かすぎる点は捨てる
  sketch.lastPx = cp;
  const ll = map.containerPointToLatLng(cp);
  sketch.pts.push({ lat: ll.lat, lng: ll.lng });
  sketch.line.addLatLng(ll);
}

const mapEl = document.getElementById('map');
// タッチ（iPhone）。なぞるボタンを押している指とは別の指を追いかける
mapEl.addEventListener('touchstart', (e) => {
  if (!sketchActive() || sketch.drawing) return;
  const t = [...e.changedTouches].find((t) => mapEl.contains(t.target));
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  sketch.touchId = t.identifier;
  strokeStart(t);
}, { passive: false, capture: true });
mapEl.addEventListener('touchmove', (e) => {
  if (!sketch.drawing) return;
  const t = [...e.changedTouches].find((t) => t.identifier === sketch.touchId);
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  strokeMove(t);
}, { passive: false, capture: true });
const touchEnd = (e) => {
  if (!sketch.drawing) return;
  if (![...e.changedTouches].some((t) => t.identifier === sketch.touchId)) return;
  e.preventDefault(); e.stopPropagation();
  finishStroke();
};
mapEl.addEventListener('touchend', touchEnd, { passive: false, capture: true });
mapEl.addEventListener('touchcancel', touchEnd, { passive: false, capture: true });

// マウス（PC）
mapEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!(sketchActive() || e.ctrlKey || e.shiftKey)) return;
  e.preventDefault(); e.stopPropagation();
  strokeStart(e);
}, true);
window.addEventListener('mousemove', (e) => { if (sketch.drawing && sketch.touchId === null) strokeMove(e); });
window.addEventListener('mouseup', () => { if (sketch.drawing && sketch.touchId === null) finishStroke(); });

// なぞった線の長さ（メートル）と、線の途中の点を取り出す道具
function pathLength(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]); return d; }
function pointAlong(pts, target) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg >= target) {
      const t = seg ? (target - acc) / seg : 0;
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t };
    }
    acc += seg;
  }
  return { ...pts[pts.length - 1] };
}

function finishStroke() {
  sketch.drawing = false;
  sketch.touchId = null;
  suppressClickUntil = Date.now() + 400;
  const pts = sketch.pts;
  setTimeout(() => { if (sketch.line && !sketch.drawing) { map.removeLayer(sketch.line); sketch.line = null; } }, 1500);
  const total = pts.length > 1 ? pathLength(pts) : 0;
  const mpp = 40075016 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  if (total < mpp * 30) return;  // 短すぎる（ただのタップ）

  // なぞった線を等間隔の点（アンカー）に置き換える。間隔は画面上でおよそ90px、最低500m
  const spacing = Math.max(500, mpp * 90);
  const n = Math.min(14, Math.max(1, Math.round(total / spacing)));
  const anchors = [];
  for (let k = 0; k <= n; k++) anchors.push(pointAlong(pts, (total * k) / n));

  pushHistory();
  const P = state.points;
  const nearIdx = (q) => {  // 画面上で近い既存の経由地（60px以内）
    let best = -1, bestPx = 60;
    P.forEach((p, i) => { const d = map.latLngToContainerPoint([p.lat, p.lng]).distanceTo(map.latLngToContainerPoint([q.lat, q.lng])); if (d < bestPx) { bestPx = d; best = i; } });
    return best;
  };
  if (P.length === 0) {
    state.points = anchors;                                   // ルートが空 → なぞった線がそのままルート
  } else {
    let a = nearIdx(anchors[0]), b = nearIdx(anchors[anchors.length - 1]);
    if (a === -1 && b === -1) {
      // どの経由地からも離れた場所から描いた → 目的地の先につなげる
      state.points = P.concat(anchors);
    } else if (a !== -1 && b !== -1 && a !== b) {
      // 2つの経由地の間をなぞった → その間を描いた線で置き換える
      let mid = anchors.slice(1, -1);
      if (a > b) { [a, b] = [b, a]; mid = mid.reverse(); }
      state.points = P.slice(0, a + 1).concat(mid, P.slice(b));
    } else if (a !== -1 && b === -1) {
      // 経由地から描き始めて、外へ伸ばした
      if (a === P.length - 1) state.points = P.concat(anchors.slice(1));            // 目的地から先へ延長
      else state.points = P.slice(0, a + 1).concat(anchors.slice(1), P.slice(a + 1)); // 途中から寄り道を足す
    } else {
      // 外から描いて経由地で終わった
      if (b === 0) state.points = anchors.slice(0, -1).concat(P);                   // 出発地の手前に追加
      else state.points = P.slice(0, b).concat(anchors.slice(0, -1), P.slice(b));
    }
  }
  state.selected = null;
  state.legs = [];
  changed();
  toast(`なぞった線から経由地を${anchors.length}個つくりました`);
}

// ===== ルートの線をドラッグして経路を変える =====
// PC：線をそのままドラッグ／iPhone：線を少し長押し（0.35秒）してからドラッグ
// （iPhoneで長押しにしているのは、地図をずらそうとして線に触れたときに勝手に変わらないようにするため）
const lineDrag = { active: false, leg: -1, touchId: null, timer: null, startPx: null, preview: null, ghost: null, pos: null };

// 画面上の点 px から一番近いルートの区間を探す → { leg, d(px) }
function nearestLeg(px) {
  let best = { leg: -1, d: Infinity };
  state.legs.forEach((leg, i) => {
    let prev = null;
    for (const c of leg.coords) {
      const cp = map.latLngToContainerPoint(c);
      if (prev) {
        const d = L.LineUtil.pointToSegmentDistance(px, prev, cp);
        if (d < best.d) best = { leg: i, d };
      }
      prev = cp;
    }
  });
  return best;
}
function nearMarker(px, r) {
  return state.points.some((p) => map.latLngToContainerPoint([p.lat, p.lng]).distanceTo(px) < r);
}
function lineDragBegin(leg, clientPt) {
  lineDrag.active = true; lineDrag.leg = leg;
  map.dragging.disable();
  const a = state.points[leg], b = state.points[leg + 1];
  const ll = map.mouseEventToLatLng(clientPt);
  lineDrag.pos = ll;
  lineDrag.preview = L.polyline([[a.lat, a.lng], ll, [b.lat, b.lng]], { color: '#ff7a1a', weight: 4, dashArray: '8 8', interactive: false }).addTo(map);
  lineDrag.ghost = L.circleMarker(ll, { radius: 12, color: '#fff', weight: 3, fillColor: '#ff7a1a', fillOpacity: 1, interactive: false }).addTo(map);
  document.getElementById('map').classList.add('line-dragging');
}
function lineDragMove(clientPt) {
  const ll = map.mouseEventToLatLng(clientPt);
  lineDrag.pos = ll;
  const a = state.points[lineDrag.leg], b = state.points[lineDrag.leg + 1];
  lineDrag.preview.setLatLngs([[a.lat, a.lng], ll, [b.lat, b.lng]]);
  lineDrag.ghost.setLatLng(ll);
}
function lineDragEnd(commit) {
  clearTimeout(lineDrag.timer); lineDrag.timer = null;
  if (!lineDrag.active) { lineDrag.touchId = null; return; }
  lineDrag.active = false;
  map.removeLayer(lineDrag.preview); map.removeLayer(lineDrag.ghost);
  document.getElementById('map').classList.remove('line-dragging');
  if (!sketchActive()) map.dragging.enable();
  suppressClickUntil = Date.now() + 400;
  lineDrag.touchId = null;
  if (!commit) return;
  pushHistory();
  // ドラッグで置いた点は「狙った場所」なので吸着しない（exact）
  state.points.splice(lineDrag.leg + 1, 0, { lat: lineDrag.pos.lat, lng: lineDrag.pos.lng, exact: true });
  state.selected = null;
  changed();
}

// マウス：線の上で押したら、すぐドラッグ開始
mapEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || sketchActive() || e.ctrlKey || e.shiftKey || !state.legs.length) return;
  const px = map.mouseEventToContainerPoint(e);
  if (nearMarker(px, 20)) return;
  const n = nearestLeg(px);
  if (n.leg < 0 || n.d > 12) return;
  e.preventDefault(); e.stopPropagation();
  lineDragBegin(n.leg, e);
}, true);
window.addEventListener('mousemove', (e) => { if (lineDrag.active && lineDrag.touchId === null) lineDragMove(e); });
window.addEventListener('mouseup', (e) => {
  if (!lineDrag.active || lineDrag.touchId !== null) return;
  // ほとんど動かしていなければ、ただのクリック扱い（その場所に経由地を挿入）
  lineDragEnd(true);
});

// タッチ：線の上を長押ししたらドラッグ開始。長押し前に指が動いたら普通の地図移動
mapEl.addEventListener('touchstart', (e) => {
  if (sketchActive() || lineDrag.active || e.touches.length !== 1 || !state.legs.length) { lineDragEnd(false); return; }
  const t = e.changedTouches[0];
  const px = map.mouseEventToContainerPoint(t);
  if (nearMarker(px, 26)) return;
  const n = nearestLeg(px);
  if (n.leg < 0 || n.d > 22) return;
  lineDrag.touchId = t.identifier; lineDrag.startPx = px;
  const startPt = { clientX: t.clientX, clientY: t.clientY };
  lineDrag.timer = setTimeout(() => { lineDragBegin(n.leg, startPt); toast('指を動かしてルートを変更'); }, 350);
}, { passive: true, capture: true });
mapEl.addEventListener('touchmove', (e) => {
  if (lineDrag.touchId === null) return;
  const t = [...e.changedTouches].find((x) => x.identifier === lineDrag.touchId);
  if (!t) return;
  if (!lineDrag.active) {
    // 長押しが成立する前に動いた → 地図をずらしたいだけなので取り消し
    if (map.mouseEventToContainerPoint(t).distanceTo(lineDrag.startPx) > 10 || e.touches.length > 1) lineDragEnd(false);
    return;
  }
  e.preventDefault(); e.stopPropagation();
  lineDragMove(t);
}, { passive: false, capture: true });
const lineTouchEnd = (e) => {
  if (lineDrag.touchId === null) return;
  if (![...e.changedTouches].some((x) => x.identifier === lineDrag.touchId)) return;
  if (lineDrag.active) { e.preventDefault(); e.stopPropagation(); }
  lineDragEnd(e.type === 'touchend');
};
mapEl.addEventListener('touchend', lineTouchEnd, { passive: false, capture: true });
mapEl.addEventListener('touchcancel', lineTouchEnd, { passive: false, capture: true });

// ===== ボタン =====
$('#btn-undo').onclick = () => {
  if (!state.history.length) return;
  state.points = state.history.pop();
  state.selected = null;
  state.legs = [];
  changed();
};
$('#btn-reverse').onclick = () => {
  if (state.points.length < 2) return;
  pushHistory(); state.points.reverse(); state.legs = []; state.selected = null; changed(); toast('出発地と目的地を入れ替えました');
};
$('#btn-save').onclick = saveCurrent;
$('#btn-start').onclick = openStartSheet;
$('#btn-resume').onclick = resumeFromHere;
$('#btn-share').onclick = shareRoute;
$('#btn-list').onclick = () => { renderList(); showSheet('#sheet-list'); };
$('#btn-new').onclick = () => {
  if (state.dirty && state.points.length && !confirm('編集中のルートは保存されていません。新しく作りますか？')) return;
  Object.assign(state, { id: null, name: '', points: [], legs: [], history: [], dirty: false, selected: null });
  renderAll(); saveDraft();
  toast('地図をタップして出発地を置いてください');
};
$('#avoid-tolls').onchange = (e) => { state.avoidTolls = e.target.checked; changed(); };
$('#main-road').onchange = (e) => { state.mainRoad = e.target.checked; storage.set('touring.mainRoad', state.mainRoad); changed(); };
$('#route-name').addEventListener('input', (e) => { state.name = e.target.value; state.dirty = true; saveDraft(); });
$('#route-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('#btn-markers').onclick = () => {
  markerMode = MARKER_MODES[(MARKER_MODES.indexOf(markerMode) + 1) % MARKER_MODES.length];
  try { localStorage.setItem('touring.markerMode', markerMode); } catch { /* 無視 */ }
  applyMarkerMode();
  toast(MARKER_MODE_LABEL[markerMode]);
};
function applyMarkerMode() {
  document.body.dataset.markers = markerMode;
  renderMarkers();
}
// 拡大縮小で込み具合が変わるので、バッジを描き直す
map.on('zoomend', () => renderMarkers());

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
  document.body.dataset.markers = markerMode;
  state.mainRoad = storage.get('touring.mainRoad', true);
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
