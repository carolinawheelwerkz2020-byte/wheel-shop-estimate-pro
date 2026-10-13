'use strict';
/* ============================================================
   Wheel Shop Estimate Pro — local-first estimate builder
   No accounts, no servers. Everything stays in this browser.
   ============================================================ */

/* ---------------- Utilities ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (cents) => moneyFmt.format((cents || 0) / 100);

function parseMoneyToCents(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/[$,\s]/g, '');
  if (s === '') return { ok: false, reason: 'blank' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, reason: 'invalid' };
  const cents = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(cents) || cents < 0) return { ok: false, reason: 'invalid' };
  if (cents > 99999999) return { ok: false, reason: 'too-big' };
  return { ok: true, cents };
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', {
  month: 'numeric', day: 'numeric', year: 'numeric'
});
const fmtDateTime = (ts) => new Date(ts).toLocaleString('en-US', {
  month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
});

function setDeep(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}
function getDeep(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/* ---------------- Constants ---------------- */
const LS_SHOP = 'wsep.v1.shop';
const LS_ESTIMATES = 'wsep.v1.estimates';
const LS_DRAFT = 'wsep.v1.draft';
const LS_COUNTER = 'wsep.v1.counter';
const MAX_PHOTOS = 6;
const APP_VERSION = '2.3';

const DAMAGE_CATS = [
  { id: 'curbRash', label: 'Curb rash' },
  { id: 'bend', label: 'Bend' },
  { id: 'crack', label: 'Crack' },
  { id: 'corrosion', label: 'Corrosion' },
  { id: 'paint', label: 'Paint damage' },
];

const POSITIONS = ['Front left', 'Front right', 'Rear left', 'Rear right', 'Spare', 'All four', 'Other'];

/* Preset prices are editable starting points for the shop's own pricing. */
const PRESETS = [
  { id: 'curb', label: 'Curb rash repair', priceCents: 12500 },
  { id: 'straighten', label: 'Wheel straightening', priceCents: 15000 },
  { id: 'crack', label: 'Crack repair', priceCents: 17500 },
  { id: 'refinish', label: 'Refinish / powder coat', priceCents: 22500 },
  { id: 'mount', label: 'Mount & balance', priceCents: 8500 },
];
const PRESET_NOTE = 'Preset prices are editable starting points. Set your own prices for your shop before sending an estimate.';

const DEFAULT_TERMS =
  'Estimate valid for 30 days. Pricing is an estimate only and may change after full in-person inspection. ' +
  'Additional damage found during repair will be quoted before work continues. A deposit may be required before work begins.';

const STEPS = [
  { id: 'customer', label: 'Customer' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'wheels', label: 'Wheels' },
  { id: 'photos', label: 'Photos' },
  { id: 'services', label: 'Services' },
  { id: 'totals', label: 'Totals' },
  { id: 'review', label: 'Review' },
];

/* ---------------- Storage (local-first) ----------------
   Photo image data lives in IndexedDB (see photoDB below), NOT localStorage:
   iOS Safari caps localStorage around ~5MB, and a few phone photos blow past
   it ("browser storage is full"). localStorage keeps tiny metadata only. */
let idbOk = false;
const store = {
  get(k, fb) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fb : JSON.parse(v);
    } catch (e) { return fb; }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(idbOk ? withoutPhotoBlobs(v) : v));
      return true;
    } catch (e) {
      toast('Could not save — browser storage is full. Try removing a photo.', 'err');
      return false;
    }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

/* ---------------- Photo blob store (IndexedDB) ---------------- */
const photoDB = {
  _db: null,
  open() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(false);
      let req;
      try { req = indexedDB.open('wsep-photos', 1); }
      catch (e) { return resolve(false); }
      req.onupgradeneeded = () => { req.result.createObjectStore('photos', { keyPath: 'id' }); };
      req.onsuccess = () => { photoDB._db = req.result; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  },
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      try {
        const tx = photoDB._db.transaction('photos', mode);
        const req = fn(tx.objectStore('photos'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb'));
      } catch (e) { reject(e); }
    });
  },
  put(id, dataUrl) { return photoDB._tx('readwrite', (st) => st.put({ id: id, dataUrl: dataUrl })); },
  get(id) {
    return photoDB._tx('readonly', (st) => st.get(id))
      .then((r) => (r && r.dataUrl) || null)
      .catch(() => null);
  },
  del(id) { return photoDB._tx('readwrite', (st) => st.delete(id)).catch(() => null); },
};

/* Deep-clone `v`, dropping dataUrl from every object inside a `photos`
   array. In-memory photo objects keep their dataUrl for rendering and PDF
   export; localStorage never sees the blobs once IndexedDB is available. */
function withoutPhotoBlobs(v) {
  if (Array.isArray(v)) return v.map(withoutPhotoBlobs);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === 'photos' && Array.isArray(v[k])) {
        out[k] = v[k].map((p) => {
          if (p && typeof p === 'object') {
            const c = withoutPhotoBlobs(p);
            delete c.dataUrl;
            return c;
          }
          return p;
        });
      } else {
        out[k] = withoutPhotoBlobs(v[k]);
      }
    }
    return out;
  }
  return v;
}

function eachPhoto(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj.photos)) obj.photos.forEach(fn);
}
function eachEstimatePhoto(fn) {
  estimates.forEach((e) => { if (e && e.data) eachPhoto(e.data, fn); });
}
function dropPhotoBlobs(list) {
  (list || []).forEach((p) => { if (idbOk && p && p.id) photoDB.del(p.id); });
}

/* ---------------- State ---------------- */
let shop = Object.assign({
  name: '', phone: '', website: '', address: '', taxRate: '', logo: ''
}, store.get(LS_SHOP, {}));
let estimates = store.get(LS_ESTIMATES, []);
let draft = store.get(LS_DRAFT, null);
let route = 'home';
let step = 0;
let lastFocus = null;

function nextEstimateNumber() {
  const n = (store.get(LS_COUNTER, 0) || 0) + 1;
  store.set(LS_COUNTER, n);
  return 'EST-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0');
}

function newWheel() {
  return {
    id: uid(), position: '', size: '', details: '', concern: '',
    damage: { curbRash: false, bend: false, crack: false, corrosion: false, paint: false },
    notes: ''
  };
}

function newEstimate() {
  return {
    id: uid(),
    number: nextEstimateNumber(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customer: { name: '', phone: '', email: '' },
    vehicle: { year: '', make: '', model: '', vin: '', mileage: '' },
    wheels: [newWheel()],
    photos: [],
    items: [],
    taxRate: shop.taxRate || '',
    terms: DEFAULT_TERMS,
  };
}

const persistDraft = debounce(() => {
  if (draft) { draft.updatedAt = Date.now(); store.set(LS_DRAFT, draft); }
}, 300);
function markDirty() { persistDraft(); }

function draftHasContent(d) {
  if (!d) return false;
  if ((d.customer.name || '').trim()) return true;
  if ((d.vehicle.make || '').trim() || (d.vehicle.model || '').trim()) return true;
  if (d.items.length || d.photos.length) return true;
  return d.wheels.some((w) =>
    (w.size || '').trim() || (w.details || '').trim() || (w.notes || '').trim() ||
    (w.concern || '').trim() || Object.values(w.damage).some(Boolean));
}

/* ---------------- Toast ---------------- */
function toast(msg, type) {
  const region = $('#toastRegion');
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'err' ? ' err' : '');
  t.textContent = msg;
  region.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

/* ---------------- Dialog (confirm) ---------------- */
function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    lastFocus = document.activeElement;
    const root = $('#dialogRoot');
    root.innerHTML =
      '<div class="dialog-backdrop" data-action="dialog-cancel">' +
      '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">' +
      '<h2 id="dlgTitle">' + esc(title) + '</h2>' +
      '<p>' + esc(body) + '</p>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-secondary" data-action="dialog-cancel">' + esc(cancelText) + '</button>' +
      '<button type="button" class="btn ' + (danger ? 'btn-danger-solid' : 'btn-navy') + '" data-action="dialog-ok">' + esc(confirmText) + '</button>' +
      '</div></div></div>';
    const done = (val) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-action="dialog-ok"]').addEventListener('click', () => done(true));
    root.querySelectorAll('[data-action="dialog-cancel"]').forEach((b) =>
      b.addEventListener('click', (e) => { if (e.target === b || b.tagName === 'BUTTON') done(false); }));
    const okBtn = root.querySelector('[data-action="dialog-ok"]');
    if (okBtn) okBtn.focus();
  });
}

/* ---------------- Lightbox ---------------- */
function showLightbox(photo) {
  lastFocus = document.activeElement;
  const root = $('#lightboxRoot');
  root.innerHTML =
    '<div class="lightbox-backdrop" role="dialog" aria-modal="true" aria-label="Photo preview">' +
    '<button type="button" class="lightbox-close" aria-label="Close photo preview">&times;</button>' +
    '<img src="' + (photo.dataUrl || '') + '" alt="' + esc(photo.label || 'Wheel photo') + '">' +
    (photo.label ? '<div class="lightbox-cap">' + esc(photo.label) + '</div>' : '') +
    '</div>';
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('.lightbox-backdrop').addEventListener('click', (e) => {
    if (e.target.classList.contains('lightbox-backdrop') || e.target.classList.contains('lightbox-close')) close();
  });
  root.querySelector('.lightbox-close').focus();
}

/* ---------------- Shared field helpers ---------------- */
function fieldHTML({ id, label, path, type = 'text', required = false, placeholder = '', hint = '', inputmode = '', value = '', rows = 0, options = null }) {
  const req = required ? ' <span class="req" aria-hidden="true">*</span>' : '';
  const reqAttr = required ? ' aria-required="true"' : '';
  const labelled = '<label for="' + id + '"' + (required ? ' class="req"' : '') + '>' + esc(label) + '</label>';
  let control = '';
  if (options) {
    control = '<select id="' + id + '" data-field="' + esc(path) + '"' + reqAttr + '>' +
      '<option value="">Select…</option>' +
      options.map((o) => '<option value="' + esc(o) + '"' + (String(value) === o ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
      '</select>';
  } else if (rows > 0) {
    control = '<textarea id="' + id + '" rows="' + rows + '" data-field="' + esc(path) + '"' + reqAttr +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '>' + esc(value) + '</textarea>';
  } else {
    control = '<input id="' + id + '" type="' + type + '" data-field="' + esc(path) + '"' + reqAttr +
      ' value="' + esc(value) + '"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
      (inputmode ? ' inputmode="' + inputmode + '"' : '') + '>';
  }
  return '<div class="field">' + labelled + control +
    '<div class="field-err" id="' + id + '-err" hidden></div>' +
    (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
}

/* ---------------- Router ---------------- */
function navigate(r, opts) {
  opts = opts || {};
  route = r;
  if (r === 'wizard' && typeof opts.step === 'number') step = opts.step;
  render();
  const main = $('#main');
  if (main) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function render() {
  const screen = $('#screen');
  const tabBar = $('#tabBar');
  tabBar.hidden = (route === 'wizard');
  $$('.tab', tabBar).forEach((t) =>
    t.setAttribute('aria-current', t.dataset.route === route ? 'page' : 'false'));

  if (route === 'home') screen.innerHTML = viewHome();
  else if (route === 'saved') screen.innerHTML = viewSaved();
  else if (route === 'shop') screen.innerHTML = viewShop();
  else if (route === 'wizard') screen.innerHTML = viewWizard();

  updateBrandHeader();
}

function updateBrandHeader() {
  const logo = $('#brandLogo'), mark = $('#brandMark'), sub = $('#brandShopName');
  if (shop.logo) { logo.src = shop.logo; logo.hidden = false; mark.style.display = 'none'; }
  else { logo.hidden = true; mark.style.display = ''; }
  sub.textContent = shop.name || 'Your shop';
}

/* ---------------- Home ---------------- */
function viewHome() {
  const savedCount = estimates.length;
  const resume = draft && draftHasContent(draft);
  const totalSaved = estimates.reduce((s, e) => s + totalsFor(e.data).total, 0);
  return '' +
    '<div class="step-head"><h1>Estimates</h1>' +
    '<p class="page-sub">Build a clear, professional wheel repair estimate in about a minute.</p></div>' +
    '<div class="card hero">' +
    (resume
      ? '<button type="button" class="btn btn-navy btn-block big-cta" data-action="resume-draft">Resume draft (' + esc(draft.number) + ')</button>' +
        '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="new-estimate">New estimate</button></div>' +
        '<p class="hint center">Starting a new estimate will ask before discarding your draft.</p>'
      : '<button type="button" class="btn btn-primary btn-block big-cta" data-action="new-estimate">+ New estimate</button>') +
    '</div>' +
    '<div class="home-stats">' +
    '<div class="stat"><b>' + savedCount + '</b><span>Saved estimates</span></div>' +
    '<div class="stat"><b>' + fmtMoney(totalSaved) + '</b><span>Total quoted</span></div>' +
    '</div>' +
    '<div class="card">' +
    '<h2>Quick links</h2>' +
    '<div class="btn-row">' +
    '<button type="button" class="btn btn-secondary" data-action="go" data-route="saved">Saved</button>' +
    '<button type="button" class="btn btn-secondary" data-action="go" data-route="shop">Shop setup</button>' +
    '</div>' +
    (!shop.name
      ? '<p class="hint mt">Tip: add your shop name, logo, and contact info in Shop setup so every report is branded.</p>'
      : '') +
    '</div>' +
    '<p class="hint center app-version">Wheel Shop Estimate Pro v' + APP_VERSION + '</p>';
}

/* ---------------- Saved estimates ---------------- */
function viewSaved() {
  let body = '';
  if (!estimates.length) {
    body = '<div class="card"><div class="empty-state">' +
      '<div class="big" aria-hidden="true">🧾</div>' +
      '<h2>No saved estimates yet</h2>' +
      '<p>Finished estimates will live here. Start one and it takes about a minute.</p>' +
      '<button type="button" class="btn btn-primary" data-action="new-estimate">Start an estimate</button>' +
      '</div></div>';
  } else {
    body = estimates.map((e) => {
      const d = e.data, t = totalsFor(d);
      const veh = [d.vehicle.year, d.vehicle.make, d.vehicle.model].filter(Boolean).join(' ');
      return '<div class="card saved-card">' +
        '<div class="saved-top"><div><div class="saved-num">' + esc(d.number) + '</div>' +
        '<div class="saved-date">' + esc(fmtDate(d.createdAt)) + '</div></div>' +
        '<span class="badge badge-final">Saved</span></div>' +
        '<div class="saved-cust">' + esc(d.customer.name || '—') + '</div>' +
        '<div class="saved-veh">' + esc(veh || 'No vehicle entered') + '</div>' +
        '<div class="saved-meta"><span class="saved-total">' + fmtMoney(t.total) + '</span>' +
        '<span>' + d.items.length + ' line item' + (d.items.length === 1 ? '' : 's') + '</span>' +
        '<span>' + d.photos.length + ' photo' + (d.photos.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="saved-actions">' +
        '<button type="button" class="btn btn-navy btn-sm" data-action="saved-open" data-id="' + esc(e.id) + '">Open</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="saved-dup" data-id="' + esc(e.id) + '">Duplicate</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-action="saved-del" data-id="' + esc(e.id) + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }
  return '<div class="step-head"><h1>Saved estimates</h1>' +
    '<p class="page-sub">Everything is stored on this device — no account needed.</p></div>' + body;
}

/* ---------------- Shop setup ---------------- */
function viewShop() {
  return '' +
    '<div class="step-head"><h1>Shop setup</h1>' +
    '<p class="page-sub">This branding appears on every customer report. Stored only on this device.</p></div>' +
    '<button type="button" class="back-btn" data-action="go" data-route="home" aria-label="Back to home"><span aria-hidden="true">‹</span> Back</button>' +
    '<form id="shopForm" novalidate><div class="card">' +
    '<h2>Branding</h2>' +
    '<div class="field"><span class="lbl" id="logoLbl">Shop logo</span>' +
    '<div class="logo-preview">' +
    (shop.logo ? '<img src="' + shop.logo + '" alt="Shop logo preview">' : '<div class="sr-only">No logo uploaded</div>') +
    '<div><button type="button" class="btn btn-secondary btn-sm" data-action="logo-pick" aria-labelledby="logoLbl">Upload logo</button>' +
    (shop.logo ? ' <button type="button" class="btn btn-danger btn-sm" data-action="logo-remove">Remove</button>' : '') +
    '</div></div>' +
    '<div class="hint">PNG or JPG. Kept on this device, printed on reports.</div></div>' +
    fieldHTML({ id: 'shop-name', label: 'Shop name', path: 'name', placeholder: 'Carolina Wheel Werkz', value: shop.name }) +
    fieldHTML({ id: 'shop-phone', label: 'Phone', path: 'phone', type: 'tel', placeholder: '(919) 555-0123', value: shop.phone }) +
    fieldHTML({ id: 'shop-website', label: 'Website', path: 'website', placeholder: 'www.example.com', value: shop.website }) +
    fieldHTML({ id: 'shop-address', label: 'Address', path: 'address', placeholder: 'Street, City, ST ZIP', value: shop.address }) +
    fieldHTML({ id: 'shop-tax', label: 'Default tax rate (%)', path: 'taxRate', inputmode: 'decimal', placeholder: '7.5', hint: 'Used as the starting tax rate on new estimates. You can change it per estimate.', value: shop.taxRate }) +
    '<div class="field-err" id="shop-tax-err" hidden></div>' +
    '<button type="submit" class="btn btn-primary btn-block">Save shop settings</button>' +
    '</div></form>' + viewBackupCard();
}

function saveShopFromForm(form) {
  const data = {
    name: $('#shop-name', form).value.trim(),
    phone: $('#shop-phone', form).value.trim(),
    website: $('#shop-website', form).value.trim(),
    address: $('#shop-address', form).value.trim(),
    taxRate: $('#shop-tax', form).value.trim(),
    logo: shop.logo,
  };
  const errEl = $('#shop-tax-err');
  if (data.taxRate !== '') {
    const r = parseTaxRate(data.taxRate);
    if (!r.ok) {
      errEl.textContent = 'Enter a tax rate between 0 and 100 (for example 7.5).';
      errEl.hidden = false;
      $('#shop-tax', form).setAttribute('aria-invalid', 'true');
      $('#shop-tax', form).focus();
      return;
    }
  }
  shop = data;
  store.set(LS_SHOP, shop);
  toast('Shop settings saved.');
  render();
}

function viewBackupCard() {
  return '' +
    '<div class="card"><h2>Backup &amp; restore</h2>' +
    '<p class="hint">Everything on this device — shop settings, all saved estimates, photos, and the current draft — can be downloaded as one backup file. Keep it somewhere safe; if this browser\'s data is ever cleared, restore brings it all back.</p>' +
    '<div class="btn-row">' +
    '<button type="button" class="btn btn-navy" data-action="backup-download">⬇ Download full backup</button>' +
    '<button type="button" class="btn btn-secondary" data-action="backup-pick">⬆ Restore from backup</button>' +
    '</div>' +
    '<p class="hint mt">Restore adds any estimates missing from this device and never deletes what\'s already here. Your current shop settings stay as they are.</p>' +
    '</div>';
}

function parseTaxRate(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/[%s]/g, '');
  if (s === '') return { ok: true, rate: 0 };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false };
  const rate = parseFloat(s);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { ok: false };
  return { ok: true, rate };
}

/* ---------------- Wizard shell ---------------- */
function viewWizard() {
  if (!draft) draft = newEstimate();
  const s = STEPS[step];
  let stepBody = '';
  if (s.id === 'customer') stepBody = stepCustomer();
  else if (s.id === 'vehicle') stepBody = stepVehicle();
  else if (s.id === 'wheels') stepBody = stepWheels();
  else if (s.id === 'photos') stepBody = stepPhotos();
  else if (s.id === 'services') stepBody = stepServices();
  else if (s.id === 'totals') stepBody = stepTotals();
  else if (s.id === 'review') stepBody = stepReview();

  const dots = STEPS.map((st, i) =>
    '<button type="button" class="step-dot' + (i === step ? ' current' : '') + (i < step ? ' done' : '') + '"' +
    ' data-action="wiz-goto" data-step="' + i + '" aria-label="Go to step ' + (i + 1) + ': ' + st.label + '"' +
    (i === step ? ' aria-current="step"' : '') + '>' +
    '<span class="n">' + (i < step ? '✓' : (i + 1)) + '</span>' + esc(st.label) + '</button>'
  ).join('');

  const isReview = s.id === 'review';
  return '' +
    '<div class="steps-bar no-print" role="navigation" aria-label="Estimate steps">' + dots + '</div>' +
    '<div class="step-head' + (isReview ? ' no-print' : '') + '">' +
    '<div class="step-kicker">Step ' + (step + 1) + ' of ' + STEPS.length + ' · ' + esc(draft.number) + '</div>' +
    '<h1>' + esc(s.label) + '</h1></div>' +
    '<div id="errSummary"></div>' +
    stepBody +
    (isReview ? '' :
      '<div class="wizard-nav no-print">' +
      (step > 0 ? '<button type="button" class="btn btn-secondary btn-back" data-action="wiz-back">Back</button>' : '') +
      '<button type="button" class="btn btn-primary" data-action="wiz-next">' + (step === STEPS.length - 2 ? 'Review report' : 'Continue') + '</button>' +
      '</div>');
}

function showErrors(errors) {
  const box = $('#errSummary');
  $$('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
  $$('.field-err').forEach((el) => { el.hidden = true; el.textContent = ''; });
  if (!errors.length) { box.innerHTML = ''; return true; }
  box.innerHTML = '<div class="err-summary" role="alert" tabindex="-1" id="errBox">' +
    '<h2>Please fix ' + errors.length + ' item' + (errors.length === 1 ? '' : 's') + '</h2><ul>' +
    errors.map((e) => '<li><a href="#' + e.id + '">' + esc(e.msg) + '</a></li>').join('') +
    '</ul></div>';
  errors.forEach((e) => {
    const input = document.getElementById(e.id);
    if (input) input.setAttribute('aria-invalid', 'true');
    const msgEl = document.getElementById(e.id + '-err');
    if (msgEl) { msgEl.textContent = e.msg; msgEl.hidden = false; }
  });
  const errBox = $('#errBox');
  if (errBox) errBox.focus();
  return false;
}

/* ---------------- Validators ---------------- */
function validateCustomer() {
  const errs = [];
  const name = draft.customer.name.trim();
  if (name.length < 2) errs.push({ id: 'c-name', msg: 'Enter the customer\u2019s name.' });
  const phoneDigits = draft.customer.phone.replace(/\D/g, '');
  if (draft.customer.phone.trim() && phoneDigits.length < 7)
    errs.push({ id: 'c-phone', msg: 'That phone number looks too short.' });
  if (draft.customer.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.customer.email.trim()))
    errs.push({ id: 'c-email', msg: 'Enter a valid email address, or leave it blank.' });
  return errs;
}

function validateVehicle() {
  const errs = [];
  if (!draft.vehicle.make.trim()) errs.push({ id: 'v-make', msg: 'Enter the vehicle make (e.g. Lexus).' });
  if (!draft.vehicle.model.trim()) errs.push({ id: 'v-model', msg: 'Enter the vehicle model (e.g. RX 350).' });
  const yr = draft.vehicle.year.trim();
  if (yr) {
    const y = parseInt(yr, 10);
    const maxY = new Date().getFullYear() + 2;
    if (!/^\d{4}$/.test(yr) || y < 1900 || y > maxY)
      errs.push({ id: 'v-year', msg: 'Enter a 4-digit year between 1900 and ' + maxY + '.' });
  }
  const vin = draft.vehicle.vin.trim().toUpperCase();
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
    errs.push({ id: 'v-vin', msg: 'A VIN is 17 characters (letters and numbers, no I, O, or Q).' });
  const mi = draft.vehicle.mileage.trim().replace(/,/g, '');
  if (mi && (!/^\d+$/.test(mi) || parseInt(mi, 10) < 0))
    errs.push({ id: 'v-mileage', msg: 'Mileage must be a whole number, or blank.' });
  return errs;
}

function validateWheels() {
  const errs = [];
  if (!draft.wheels.length) errs.push({ id: 'wheel-add-btn', msg: 'Add at least one wheel.' });
  draft.wheels.forEach((w, i) => {
    const n = i + 1;
    if (!w.position) errs.push({ id: 'w-pos-' + w.id, msg: 'Wheel ' + n + ': choose a wheel position.' });
    if (!w.size.trim()) errs.push({ id: 'w-size-' + w.id, msg: 'Wheel ' + n + ': enter the wheel size (e.g. 20x9).' });
  });
  return errs;
}

function validateServices() {
  const errs = [];
  if (!draft.items.length) errs.push({ id: 'preset-curb', msg: 'Add at least one service line item.' });
  draft.items.forEach((it, i) => {
    const n = i + 1;
    if (!it.desc.trim()) errs.push({ id: 'item-desc-' + it.id, msg: 'Line ' + n + ': enter a description.' });
    const r = parseMoneyToCents(it.priceStr);
    if (!r.ok) errs.push({
      id: 'item-price-' + it.id,
      msg: 'Line ' + n + ': enter a valid price (numbers only, e.g. 149.99).'
    });
    else it.priceCents = r.cents;
  });
  return errs;
}

function validateTotals() {
  const errs = [];
  const r = parseTaxRate(draft.taxRate);
  if (!r.ok) errs.push({ id: 't-tax', msg: 'Enter a tax rate between 0 and 100 (for example 7.5).' });
  return errs;
}

function validateStep(id) {
  if (id === 'customer') return validateCustomer();
  if (id === 'vehicle') return validateVehicle();
  if (id === 'wheels') return validateWheels();
  if (id === 'services') return validateServices();
  if (id === 'totals') return validateTotals();
  return [];
}

/* ---------------- Step: Customer ---------------- */
function stepCustomer() {
  return '<div class="card">' +
    fieldHTML({ id: 'c-name', label: 'Customer name', path: 'customer.name', required: true, placeholder: 'Full name', value: draft.customer.name }) +
    '<div class="field-row">' +
    fieldHTML({ id: 'c-phone', label: 'Phone', path: 'customer.phone', type: 'tel', inputmode: 'tel', placeholder: '(919) 555-0123', value: draft.customer.phone }) +
    fieldHTML({ id: 'c-email', label: 'Email', path: 'customer.email', type: 'email', inputmode: 'email', placeholder: 'name@email.com', value: draft.customer.email }) +
    '</div></div>';
}

/* ---------------- Free VIN decode (NHTSA vPIC — free, no key) ---------------- */
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_VALUES = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
/* ISO 3779 check digit (9th character) — catches typos before the lookup. */
function vinCheckDigitOk(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = c >= '0' && c <= '9' ? +c : VIN_VALUES[c];
    if (v == null) return false;
    sum += v * VIN_WEIGHTS[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}

function parseNhtsaVin(json) {
  const r = json && json.Results && json.Results[0];
  if (!r) return { ok: false, reason: 'empty' };
  if (String(r.ErrorCode) !== '0') {
    return { ok: false, reason: 'api', message: r.ErrorText || 'VIN not recognized' };
  }
  const year = (r.ModelYear || '').trim();
  const make = (r.Make || '').trim();
  let model = (r.Model || '').trim();
  const trim = (r.Trim || '').trim();
  if (trim && model && model.toLowerCase().indexOf(trim.toLowerCase()) < 0) model += ' ' + trim;
  if (!year && !make && !model) return { ok: false, reason: 'empty' };
  return { ok: true, year, make, model };
}

function setVehicleField(path, value) {
  setDeep(draft, path, value);
  const el = document.querySelector('[data-field="' + path + '"]');
  if (el) el.value = value;
}

async function decodeVin() {
  if (!draft) return;
  const input = $('#v-vin');
  const vin = (((input && input.value) || draft.vehicle.vin) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    toast('Enter the full 17-character VIN first (no I, O, or Q).', 'err');
    if (input) input.focus();
    return;
  }
  if (!vinCheckDigitOk(vin)) {
    toast('That VIN fails the check-digit test — double-check it and try again.', 'err');
    return;
  }
  const btn = document.querySelector('[data-action="vin-decode"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Decoding…'; }
  try {
    const res = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + vin + '?format=json');
    if (!res.ok) throw new Error('http ' + res.status);
    const p = parseNhtsaVin(await res.json());
    if (!p.ok) {
      toast(p.reason === 'api' ? 'VIN not recognized: ' + p.message : 'Could not decode that VIN.', 'err');
      return;
    }
    if (p.year) setVehicleField('vehicle.year', p.year);
    if (p.make) setVehicleField('vehicle.make', p.make);
    if (p.model) setVehicleField('vehicle.model', p.model);
    markDirty();
    toast('Decoded: ' + [p.year, p.make, p.model].filter(Boolean).join(' '));
  } catch (e) {
    toast('VIN lookup needs an internet connection.', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Decode VIN'; }
  }
}

/* ---------------- VIN camera scan (on-device OCR — free, no server) ----------------
   Reads the VIN from a photo of the dash plate or door jamb, then runs it
   through the same NHTSA decode as a typed VIN. The OCR engine is bundled
   locally, so after the first load it works fully offline. */
const VIN_CONFUSIONS = {
  B: '8', '8': 'B', D: '0', '0': 'D', S: '5', '5': 'S',
  G: '6', '6': 'G', Z: '2', '2': 'Z', A: '4', '4': 'A',
  I: '1', L: '1', O: '0', Q: '0', '1': 'I', '7': '1',
  H: 'N', N: 'H', M: 'N', E: 'F', F: 'E', C: 'G',
  U: 'V', V: 'U', Y: 'V', K: 'X', X: 'K', P: 'R', R: 'P',
};

/* Pull VIN-shaped candidates out of raw OCR text. VINs are usually printed
   as one token, but plates often split them across lines ("1HG CM8 263
   3A00 4352"), so adjacent short tokens are joined when they sum to 17. */
/* Pull 17-char VIN-shaped candidates out of OCR text — line by line, never
   joining text across line breaks (that fabricated a false VIN out of a
   door label once: "GAWRFRT3266KG1792"). Position 9 (index 8) is the VIN
   check digit, which per the VIN standard is always 0-9 or X — requiring
   that kills most accidental matches from label text. */
function extractVinCandidates(ocrText) {
  const out = [];
  const push = (c) => {
    if (!/[0-9X]/.test(c[8])) return;
    if (out.indexOf(c) < 0) out.push(c);
  };
  const lines = String(ocrText || '').toUpperCase().split('\n');
  const vinRe = /^[A-HJ-NPR-Z0-9]{17}$/;
  lines.forEach((line) => {
    const tokens = line.split(/\s+/)
      .map((t) => t.replace(/[^A-Z0-9]/g, ''))
      .filter((t) => t.length > 0);
    tokens.forEach((t) => {
      if (t.length === 17) { if (vinRe.test(t)) push(t); }
      else if (t.length > 17) {
        for (let i = 0; i + 17 <= t.length; i++) {
          const w = t.slice(i, i + 17);
          if (vinRe.test(w)) push(w);
        }
      }
    });
    for (let i = 0; i < tokens.length; i++) {
      let s = '';
      for (let j = i; j < tokens.length && j < i + 5; j++) {
        s += tokens[j];
        if (s.length === 17) { if (vinRe.test(s)) push(s); break; }
        if (s.length > 17) break;
      }
    }
  });
  return out;
}

/* If the check digit fails, try single-character OCR-confusion fixes,
   weakest characters first — Tesseract reports per-symbol confidence, and
   the misread is usually the character it was least sure about. */
function repairVinOcr(cand, symbols) {
  if (vinCheckDigitOk(cand)) return cand;
  const order = [];
  for (let i = 0; i < 17; i++) order.push(i);
  /* Only trust the confidences when the symbols line up 1:1 with the
     candidate (no spaces or extra fragments in the OCR text). */
  let conf = null;
  if (symbols && symbols.length === cand.length) {
    const joined = symbols.map((s) => String((s && s.text) || '').toUpperCase()).join('');
    if (joined === cand) conf = symbols;
  }
  if (conf) {
    order.sort((a, b) => (conf[a].confidence || 100) - (conf[b].confidence || 100));
  }
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const alt = VIN_CONFUSIONS[cand[i]];
    if (!alt) continue;
    const fixed = cand.slice(0, i) + alt + cand.slice(i + 1);
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(fixed) && vinCheckDigitOk(fixed)) return fixed;
  }
  return null;
}

/* Returns { vin, auto } or null. auto=true means the check digit passed on
   the raw read — safe to decode immediately. auto=false means a repair was
   needed, so the user should eyeball the VIN before decoding. */
function vinFromOcrText(ocrText, symbols) {
  const cands = extractVinCandidates(ocrText);
  for (let i = 0; i < cands.length; i++) {
    if (vinCheckDigitOk(cands[i])) return { vin: cands[i], auto: true };
  }
  for (let i = 0; i < cands.length; i++) {
    const fixed = repairVinOcr(cands[i], symbols);
    if (fixed) return { vin: fixed, auto: false };
  }
  return null;
}

let tessWorkerPromise = null;
let tessStatus = '';
function setTessStatus(s) { tessStatus = s; }
function loadTesseractLib() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'tesseract.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('ocr-lib'));
    document.head.appendChild(s);
  });
}

function buildVinOcrWorker() {
  return (async () => {
    setTessStatus('Loading scanner…');
    await loadTesseractLib();
    const T = window.Tesseract;
    if (!T || !T.createWorker) throw new Error('ocr-lib');
    const base = new URL('.', location.href).href;
    setTessStatus('Starting scanner…');
    const worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, {
      workerPath: base + 'tesseract-worker.min.js',
      corePath: base,
      langPath: base,
      /* The bundled language file is eng.traineddata (not .gz). Tesseract's
         gzip option defaults to true, which makes it request
         eng.traineddata.gz -> 404 -> the createWorker promise never settles.
         gzip:false makes it fetch the file we actually ship. */
      gzip: false,
      logger: (m) => {
        try {
          if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
            setTessStatus('Reading VIN… ' + Math.round(m.progress * 100) + '%');
          } else if (m && m.status) {
            setTessStatus('Scanner: ' + m.status + '…');
          }
        } catch (e) {}
      },
    });
    setTessStatus('Preparing scanner…');
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: T.PSM.SINGLE_BLOCK, /* real photos have surrounding label text; single-word mode returns nothing on them */
    });
    setTessStatus('');
    return worker;
  })();
}

function getVinOcrWorker() {
  if (!tessWorkerPromise) {
    tessWorkerPromise = buildVinOcrWorker().catch((e) => { tessWorkerPromise = null; throw e; });
  }
  return tessWorkerPromise;
}

/* Start loading the OCR engine while the user is on the Vehicle step, so
   it's warm by the time they tap Scan VIN. Silent unless they scan. */
function preloadVinOcr() {
  try { getVinOcrWorker().catch(() => {}); } catch (e) {}
}

/* Rejects if the worker takes longer than ms — a stuck load must never
   leave the button spinning forever. The build keeps running in the
   background, so a later tap can still pick up the ready worker. */
function ocrTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ocr-timeout')), ms);
  });
  return Promise.race([promise, timeout]).then(
    (v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; }
  );
}

function scanVin() {
  if (!draft) return;
  const input = $('#vinScanInput');
  if (!input) { toast('Scanner not ready — reload the app and try again.', 'err'); return; }
  input.click();
}

async function handleVinScanFile(file) {
  if (!draft) return;
  const btn = document.querySelector('[data-action="vin-scan"]');
  const setBtn = (t, dis) => { if (btn) { btn.textContent = t; btn.disabled = !!dis; } };
  /* Mirror the engine's real status onto the button so a slow load shows
     where it is instead of looking stuck. */
  const tick = setInterval(() => { if (tessStatus) setBtn(tessStatus, true); }, 400);
  /* Stamped VIN plates are low-contrast, so OCR gets several looks: the
     photo as-is, then contrast-stretched, then inverted (light-on-dark
     plates), then a 2x upscale for small text. First check-digit-valid
     read wins; a repaired guess is only a fallback. */
  const loadImgEl = (dataUrl) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('unreadable'));
    im.src = dataUrl;
  });
  const contrastCanvas = (img, invert, scale) => {
    const w = Math.round(img.naturalWidth * (scale || 1));
    const h = Math.round(img.naturalHeight * (scale || 1));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const p = d.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < p.length; i += 4) {
      const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < p.length; i += 4) {
      let g = ((p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 - lo) * 255 / range;
      if (invert) g = 255 - g;
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  };
  try {
    setBtn('Loading scanner…', true);
    const dataUrl = await processImageFile(file, 1600, 0.92);
    const worker = await ocrTimeout(getVinOcrWorker(), 90000);
    const imgEl = await loadImgEl(dataUrl);
    const passes = [
      dataUrl,
      contrastCanvas(imgEl, false, 1).toDataURL('image/png'),
      contrastCanvas(imgEl, true, 1).toDataURL('image/png'),
      contrastCanvas(imgEl, false, 2).toDataURL('image/png'),
    ];
    let repaired = null;
    for (let i = 0; i < passes.length; i++) {
      setTessStatus('Reading VIN…');
      let res = null;
      try {
        res = await ocrTimeout(worker.recognize(passes[i]), 30000);
      } catch (e) { continue; }
      const found = vinFromOcrText(res && res.data && res.data.text, res && res.data && res.data.symbols);
      if (found && found.auto) {
        setVehicleField('vehicle.vin', found.vin);
        markDirty();
        await decodeVin();
        return;
      }
      if (found && !repaired) repaired = found;
    }
    if (repaired) {
      setVehicleField('vehicle.vin', repaired.vin);
      markDirty();
      toast('I read VIN ' + repaired.vin + ' — check it against the plate, then tap Decode VIN.');
      return;
    }
    toast('Couldn\'t read a VIN from that photo — get closer, straight-on, no glare on the label.', 'err');
  } catch (e) {
    /* On timeout the build keeps running in the background — don't discard
       it, so a later tap can pick up the ready worker. */
    if (!e || e.message !== 'ocr-timeout') tessWorkerPromise = null;
    if (e && e.message === 'ocr-timeout') {
      toast('The scanner timed out — check your connection and try again.', 'err');
    } else if (e && e.message === 'ocr-lib') {
      toast('Could not load the scanner — check your connection and try again.', 'err');
    } else {
      toast('VIN scan failed — try again with a clearer photo.', 'err');
    }
  } finally {
    clearInterval(tick);
    setTessStatus('');
    setBtn('📷 Scan VIN', false);
  }
}

/* ---------------- Step: Vehicle ---------------- */
function stepVehicle() {
  preloadVinOcr(); /* warm up the VIN scanner while the user is here */
  return '<div class="card">' +
    '<div class="field-row3">' +
    fieldHTML({ id: 'v-year', label: 'Year', path: 'vehicle.year', inputmode: 'numeric', placeholder: '2021', value: draft.vehicle.year }) +
    fieldHTML({ id: 'v-make', label: 'Make', path: 'vehicle.make', required: true, placeholder: 'Lexus', value: draft.vehicle.make }) +
    fieldHTML({ id: 'v-model', label: 'Model', path: 'vehicle.model', required: true, placeholder: 'RX 350', value: draft.vehicle.model }) +
    '</div>' +
    '<div class="field-row">' +
    fieldHTML({ id: 'v-vin', label: 'VIN (optional)', path: 'vehicle.vin', placeholder: '17-character VIN', value: draft.vehicle.vin }) +
    fieldHTML({ id: 'v-mileage', label: 'Mileage (optional)', path: 'vehicle.mileage', inputmode: 'numeric', placeholder: '84500', value: draft.vehicle.mileage }) +
    '</div>' +
    '<div class="vin-decode-row no-print">' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="vin-scan">📷 Scan VIN</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-action="vin-decode">🔍 Decode VIN</button>' +
    '<span class="hint">Scan the VIN plate with the camera, or type the VIN and decode — free lookup fills year, make &amp; model.</span>' +
    '</div></div>';
}

/* ---------------- Step: Wheels & inspection ---------------- */
function wheelCard(w, i) {
  const chips = DAMAGE_CATS.map((c) =>
    '<span class="chip-check"><input type="checkbox" id="dmg-' + w.id + '-' + c.id + '"' +
    ' data-wheel="' + w.id + '" data-damage="' + c.id + '"' + (w.damage[c.id] ? ' checked' : '') + '>' +
    '<label class="chip" for="dmg-' + w.id + '-' + c.id + '">' + esc(c.label) + '</label></span>'
  ).join('');
  return '<div class="card" data-wheel-card="' + w.id + '">' +
    '<div class="saved-top"><h3>Wheel ' + (i + 1) + '</h3>' +
    (draft.wheels.length > 1
      ? '<button type="button" class="btn btn-danger btn-sm" data-action="wheel-remove" data-id="' + w.id + '">Remove</button>'
      : '') + '</div>' +
    '<div class="field-row">' +
    '<div class="field"><label for="w-pos-' + w.id + '" class="req">Position</label>' +
    '<select id="w-pos-' + w.id + '" data-wheel="' + w.id + '" data-wfield="position" aria-required="true">' +
    '<option value="">Select…</option>' +
    POSITIONS.map((p) => '<option' + (w.position === p ? ' selected' : '') + '>' + esc(p) + '</option>').join('') +
    '</select><div class="field-err" id="w-pos-' + w.id + '-err" hidden></div></div>' +
    '<div class="field"><label for="w-size-' + w.id + '" class="req">Wheel size</label>' +
    '<input id="w-size-' + w.id + '" type="text" data-wheel="' + w.id + '" data-wfield="size" value="' + esc(w.size) + '"' +
    ' placeholder="e.g. 20x9" aria-required="true"><div class="field-err" id="w-size-' + w.id + '-err" hidden></div></div>' +
    '</div>' +
    '<div class="field"><label for="w-det-' + w.id + '">Wheel details</label>' +
    '<input id="w-det-' + w.id + '" type="text" data-wheel="' + w.id + '" data-wfield="details" value="' + esc(w.details) + '"' +
    ' placeholder="Finish, brand, OEM/aftermarket…"></div>' +
    '<div class="field"><label for="w-con-' + w.id + '">Customer concern</label>' +
    '<input id="w-con-' + w.id + '" type="text" data-wheel="' + w.id + '" data-wfield="concern" value="' + esc(w.concern) + '"' +
    ' placeholder="What the customer noticed…"></div>' +
    '<div class="field"><span class="lbl" id="dmg-lbl-' + w.id + '">Damage found</span>' +
    '<div class="chip-grid" role="group" aria-labelledby="dmg-lbl-' + w.id + '">' + chips + '</div></div>' +
    '<div class="field"><label for="w-notes-' + w.id + '">Inspection notes</label>' +
    '<textarea id="w-notes-' + w.id + '" rows="2" data-wheel="' + w.id + '" data-wfield="notes" placeholder="What you found on inspection…">' + esc(w.notes) + '</textarea></div>' +
    '</div>';
}

function stepWheels() {
  return '<div id="wheelList">' +
    draft.wheels.map((w, i) => wheelCard(w, i)).join('') +
    '</div>' +
    '<button type="button" id="wheel-add-btn" class="btn btn-secondary btn-block" data-action="wheel-add">+ Add another wheel</button>';
}

/* ---------------- Step: Photos ---------------- */
function stepPhotos() {
  const remaining = MAX_PHOTOS - draft.photos.length;
  const cards = draft.photos.map((p) =>
    '<div class="photo-card">' +
    '<button type="button" data-action="photo-view" data-id="' + p.id + '" aria-label="View photo ' + esc(p.label || 'untitled') + '" style="border:0;padding:0;background:none;cursor:pointer;display:block;width:100%">' +
    '<img src="' + (p.dataUrl || '') + '" alt="' + esc(p.label || 'Wheel photo') + '" loading="lazy"></button>' +
    '<input type="text" class="photo-label-input" data-photo-label="' + p.id + '" value="' + esc(p.label) + '" placeholder="Label (e.g. Front left — before)" aria-label="Photo label" maxlength="60">' +
    '<div class="photo-card-footer">' +
    '<button type="button" class="btn btn-secondary" data-action="photo-view" data-id="' + p.id + '">View</button>' +
    '<button type="button" class="btn btn-danger" data-action="photo-remove" data-id="' + p.id + '">Remove</button>' +
    '</div></div>'
  ).join('');

  return '<div class="card">' +
    '<div class="photo-count">' + draft.photos.length + ' of ' + MAX_PHOTOS + ' photos</div>' +
    (remaining > 0
      ? '<div class="photo-actions">' +
        '<button type="button" class="btn btn-navy" data-action="photo-take">📷 Take photo</button>' +
        '<button type="button" class="btn btn-secondary" data-action="photo-choose">🖼 Choose photos</button>' +
        '</div>' +
        '<div id="photoSpinner"></div>'
      : '<p class="hint">Photo limit reached (' + MAX_PHOTOS + '). Remove a photo to add a different one.</p>') +
    (draft.photos.length
      ? '<div class="photo-grid">' + cards + '</div>'
      : '<div class="empty-state"><div class="big" aria-hidden="true">📸</div>' +
        '<p>Photos make estimates clearer and protect the shop.<br>Before/after shots are gold.</p></div>') +
    '</div>';
}

function processImageFile(file, maxDim, quality, whiteBg) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (whiteBg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}

async function handlePhotoFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.indexOf('image/') === 0);
  if (!files.length) { toast('No image files selected.', 'err'); return; }
  const room = MAX_PHOTOS - draft.photos.length;
  if (room <= 0) { toast('Photo limit reached (' + MAX_PHOTOS + ').', 'err'); return; }
  const batch = files.slice(0, room);
  if (files.length > room) toast('Only ' + room + ' more photo' + (room === 1 ? '' : 's') + ' fit — limit is ' + MAX_PHOTOS + '.', 'err');
  const spin = $('#photoSpinner');
  if (spin) spin.innerHTML = '<div class="photo-spinner"><span class="spinner" aria-hidden="true"></span>Processing photo' + (batch.length === 1 ? '' : 's') + '…</div>';
  let added = 0;
  for (const f of batch) {
    try {
      const dataUrl = await processImageFile(f, 1400, 0.82);
      const pid = uid();
      if (idbOk) { try { await photoDB.put(pid, dataUrl); } catch (e) { /* blob stays memory-only */ } }
      draft.photos.push({ id: pid, dataUrl: dataUrl, label: '', ts: Date.now() });
      added++;
    } catch (e) { /* skip bad file */ }
  }
  markDirty();
  render();
  if (added) toast(added + ' photo' + (added === 1 ? '' : 's') + ' added.');
  else toast('Could not read those images.', 'err');
}

/* ---------------- Totals math ---------------- */
function totalsFor(d) {
  const subtotal = d.items.reduce((s, it) => {
    const r = parseMoneyToCents(it.priceStr);
    return s + (r.ok ? r.cents : (it.priceCents || 0));
  }, 0);
  const tr = parseTaxRate(d.taxRate);
  const rate = tr.ok ? tr.rate : 0;
  const tax = Math.round(subtotal * rate / 100);
  return { subtotal, tax, total: subtotal + tax, rate };
}

/* ---------------- Step: Services ---------------- */
function itemCard(it) {
  return '<div class="item-card" data-item="' + it.id + '">' +
    '<div class="item-top">' +
    '<input type="text" id="item-desc-' + it.id + '" data-item-desc="' + it.id + '" value="' + esc(it.desc) + '" placeholder="Service description" aria-label="Service description">' +
    '<button type="button" class="icon-btn" data-action="item-remove" data-id="' + it.id + '" aria-label="Remove ' + esc(it.desc || 'line item') + '">×</button>' +
    '</div>' +
    '<div class="item-price-row"><div class="price-wrap"><span aria-hidden="true">$</span>' +
    '<input type="text" id="item-price-' + it.id + '" data-item-price="' + it.id + '" value="' + esc(it.priceStr) + '" inputmode="decimal" placeholder="0.00" aria-label="Price in dollars"></div></div>' +
    '<div class="field-err" id="item-desc-' + it.id + '-err" hidden></div>' +
    '<div class="field-err" id="item-price-' + it.id + '-err" hidden></div>' +
    '</div>';
}

function stepServices() {
  const presets = PRESETS.map((p) =>
    '<button type="button" class="preset-btn" id="preset-' + p.id + '" data-action="preset-add" data-id="' + p.id + '">' +
    '+ ' + esc(p.label) + '<small>' + fmtMoney(p.priceCents) + '</small></button>'
  ).join('');
  const items = draft.items.map(itemCard).join('');
  const t = totalsFor(draft);
  return '<div class="card"><h2>Quick add</h2>' +
    '<div class="preset-grid">' + presets + '</div>' +
    '<p class="preset-note">' + esc(PRESET_NOTE) + '</p></div>' +
    '<div class="card"><h2>Line items' + (draft.items.length ? ' (' + draft.items.length + ')' : '') + '</h2>' +
    '<div id="itemList">' +
    (items || '<div class="empty-state"><div class="big" aria-hidden="true">🔧</div><p>No services yet.<br>Tap a preset above or add a custom line.</p></div>') +
    '</div>' +
    '<button type="button" class="btn btn-secondary btn-block mt" data-action="item-add">+ Add custom line item</button></div>' +
    (draft.items.length ?
      '<div class="card"><div class="totals-box" id="servicesTotals">' +
      '<div class="totals-row"><span>Subtotal</span><span>' + fmtMoney(t.subtotal) + '</span></div>' +
      '<div class="hint">Tax is set on the next step.</div>' +
      '</div></div>' : '');
}

function addItem(desc, cents) {
  const priceStr = cents != null ? (cents / 100).toFixed(2) : '';
  draft.items.push({ id: uid(), desc: desc || '', priceStr, priceCents: cents || 0 });
  markDirty();
  render();
  if (!desc) {
    const last = draft.items[draft.items.length - 1];
    const el = document.getElementById('item-desc-' + last.id);
    if (el) el.focus();
  }
}

/* ---------------- Step: Totals & terms ---------------- */
function stepTotals() {
  const t = totalsFor(draft);
  return '<div class="card">' +
    fieldHTML({ id: 't-tax', label: 'Tax rate (%)', path: 'taxRate', inputmode: 'decimal', placeholder: '7.5', hint: 'Enter 0 for no tax.', value: draft.taxRate }) +
    '<div class="totals-box">' +
    '<div class="totals-row"><span>Subtotal</span><span>' + fmtMoney(t.subtotal) + '</span></div>' +
    '<div class="totals-row"><span>Tax (' + t.rate + '%)</span><span>' + fmtMoney(t.tax) + '</span></div>' +
    '<div class="totals-row grand"><span>Estimated total</span><span>' + fmtMoney(t.total) + '</span></div>' +
    '</div></div>' +
    '<div class="card">' +
    '<div class="field"><label for="t-terms">Estimate terms</label>' +
    '<textarea id="t-terms" rows="5" data-field="terms">' + esc(draft.terms) + '</textarea>' +
    '<div class="hint">Shown on the customer report. Keep it accurate for your shop.</div></div>' +
    '</div>';
}

/* ---------------- Report builder (screen + print + share) ---------------- */
function reportHTML(d, forShare) {
  const s = (d.shopSnapshot) || shop;
  const t = totalsFor(d);
  const veh = [d.vehicle.year, d.vehicle.make, d.vehicle.model].filter(Boolean).join(' ');
  const validThrough = fmtDate(d.createdAt + 30 * 24 * 3600 * 1000);

  const wheels = d.wheels.map((w, i) => {
    const dmg = DAMAGE_CATS.filter((c) => w.damage[c.id]).map((c) => c.label);
    return '<div class="report-sec"><h3>Wheel ' + (i + 1) + (w.position ? ' — ' + esc(w.position) : '') + '</h3>' +
      '<dl class="report-kv">' +
      (w.size ? '<dt>Size</dt><dd>' + esc(w.size) + '</dd>' : '') +
      (w.details ? '<dt>Details</dt><dd>' + esc(w.details) + '</dd>' : '') +
      (w.concern ? '<dt>Customer concern</dt><dd>' + esc(w.concern) + '</dd>' : '') +
      (w.notes ? '<dt>Inspection notes</dt><dd>' + esc(w.notes) + '</dd>' : '') +
      '</dl>' +
      (dmg.length ? '<div class="damage-tags">' + dmg.map((x) => '<span class="damage-tag">' + esc(x) + '</span>').join('') + '</div>' : '') +
      '</div>';
  }).join('');

  const photos = d.photos.length
    ? '<div class="report-sec"><h3>Photos (' + d.photos.length + ')</h3><div class="report-photos">' +
      d.photos.map((p) =>
        '<figure><img src="' + (p.dataUrl || '') + '" alt="' + esc(p.label || 'Wheel photo') + '" loading="lazy">' +
        (p.label ? '<figcaption>' + esc(p.label) + '</figcaption>' : '') + '</figure>'
      ).join('') + '</div></div>'
    : '';

  const items = d.items.map((it) => {
    const r = parseMoneyToCents(it.priceStr);
    const cents = r.ok ? r.cents : (it.priceCents || 0);
    return '<tr><td>' + esc(it.desc) + '</td><td class="amt">' + fmtMoney(cents) + '</td></tr>';
  }).join('');

  const contact = [s.phone, s.website].filter(Boolean).join(' · ');

  return '<article class="report" aria-label="Estimate report">' +
    '<div class="report-header">' +
    (s.logo ? '<img class="report-logo" src="' + s.logo + '" alt="' + esc(s.name || 'Shop') + ' logo">' : '') +
    '<div class="report-shop"><h2>' + esc(s.name || 'Wheel Repair Estimate') + '</h2>' +
    (contact ? '<p>' + esc(contact) + '</p>' : '') +
    (s.address ? '<p>' + esc(s.address) + '</p>' : '') + '</div></div>' +
    '<div class="report-meta">' +
    '<div><strong>Estimate</strong>' + esc(d.number) + '</div>' +
    '<div><strong>Date</strong>' + esc(fmtDate(d.createdAt)) + '</div>' +
    '<div><strong>Valid through</strong>' + esc(validThrough) + '</div>' +
    '</div>' +
    '<div class="report-sec"><h3>Customer</h3><dl class="report-kv">' +
    '<dt>Name</dt><dd>' + esc(d.customer.name || '—') + '</dd>' +
    (d.customer.phone ? '<dt>Phone</dt><dd>' + esc(d.customer.phone) + '</dd>' : '') +
    (d.customer.email ? '<dt>Email</dt><dd>' + esc(d.customer.email) + '</dd>' : '') +
    '</dl></div>' +
    '<div class="report-sec"><h3>Vehicle</h3><dl class="report-kv">' +
    '<dt>Vehicle</dt><dd>' + esc(veh || '—') + '</dd>' +
    (d.vehicle.vin ? '<dt>VIN</dt><dd>' + esc(d.vehicle.vin) + '</dd>' : '') +
    (d.vehicle.mileage ? '<dt>Mileage</dt><dd>' + esc(d.vehicle.mileage) + '</dd>' : '') +
    '</dl></div>' +
    wheels + photos +
    '<div class="report-sec"><h3>Recommended work</h3>' +
    '<table class="items"><thead><tr><th>Service</th><th class="amt">Price</th></tr></thead>' +
    '<tbody>' + items + '</tbody></table>' +
    '<div class="report-totals"><div class="totals-box">' +
    '<div class="totals-row"><span>Subtotal</span><span>' + fmtMoney(t.subtotal) + '</span></div>' +
    '<div class="totals-row"><span>Tax (' + t.rate + '%)</span><span>' + fmtMoney(t.tax) + '</span></div>' +
    '<div class="totals-row grand"><span>Estimated total</span><span>' + fmtMoney(t.total) + '</span></div>' +
    '</div></div></div>' +
    '<div class="report-sec"><h3>Terms</h3><div class="report-terms">' + esc(d.terms) + '</div>' +
    '<div class="sig-row"><div><div class="sig-line">Customer approval / Date</div></div>' +
    '<div><div class="sig-line">Authorized by / Date</div></div></div></div>' +
    '<div class="report-foot">Thank you for trusting ' + esc(s.name || 'our shop') + ' with your wheels.</div>' +
    '</article>';
}

/* ---------------- Step: Review ---------------- */
function stepReview() {
  const errs = validateCustomer().concat(validateVehicle(), validateWheels(), validateServices(), validateTotals());
  const warn = errs.length
    ? '<div class="err-summary no-print" role="alert"><h2>This estimate has ' + errs.length + ' issue' + (errs.length === 1 ? '' : 's') + '</h2>' +
      '<p style="margin:0">Fix the highlighted steps before sharing or printing. ' +
      '<button type="button" class="btn btn-navy btn-sm" data-action="review-fix" style="margin-top:8px">Go fix it</button></p></div>'
    : '';
  return warn +
    '<div id="reportSlot">' + reportHTML(draft) + '</div>' +
    '<div class="card no-print"><h2>Finish</h2><div class="action-grid">' +
    '<button type="button" class="btn btn-navy" data-action="save-estimate">💾 Save estimate</button>' +
    '<button type="button" class="btn btn-primary" data-action="share">📤 Share</button>' +
    '<button type="button" class="btn btn-secondary" data-action="report-download">⬇ Download PDF</button>' +
    '<button type="button" class="btn btn-secondary" data-action="copy-summary">📋 Copy summary</button>' +
    '<button type="button" class="btn btn-secondary" data-action="print">🖨 Print / PDF</button>' +
    '</div>' +
    '<hr class="divider">' +
    '<button type="button" class="btn btn-ghost btn-block" data-action="new-estimate">Start a new estimate</button>' +
    '</div>';
}

/* ---------------- Share / copy / print / save ---------------- */
function buildSummaryText(d) {
  const s = d.shopSnapshot || shop;
  const t = totalsFor(d);
  const veh = [d.vehicle.year, d.vehicle.make, d.vehicle.model].filter(Boolean).join(' ');
  const lines = [];
  lines.push(s.name || 'Wheel Repair Estimate');
  if (s.phone) lines.push(s.phone);
  lines.push('Estimate ' + d.number + ' — ' + fmtDate(d.createdAt));
  lines.push('');
  lines.push('Customer: ' + (d.customer.name || '—'));
  if (veh) lines.push('Vehicle: ' + veh);
  d.wheels.forEach((w, i) => {
    const bits = [w.position, w.size].filter(Boolean).join(' ');
    if (bits) lines.push('Wheel ' + (i + 1) + ': ' + bits);
  });
  lines.push('');
  lines.push('Recommended work:');
  d.items.forEach((it) => {
    const r = parseMoneyToCents(it.priceStr);
    lines.push('• ' + it.desc + ' — ' + fmtMoney(r.ok ? r.cents : (it.priceCents || 0)));
  });
  lines.push('');
  lines.push('Subtotal: ' + fmtMoney(t.subtotal));
  lines.push('Tax (' + t.rate + '%): ' + fmtMoney(t.tax));
  lines.push('Estimated total: ' + fmtMoney(t.total));
  return lines.join('\n');
}


/* ---------------- Real PDF report (jsPDF is bundled, so this works offline) ---------------- */
function isIOS() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function buildPdf(d) {
  const NS = window.jspdf || {};
  if (!NS.jsPDF) throw new Error('PDF engine not loaded');
  const doc = new NS.jsPDF({ unit: 'pt', format: 'letter' });
  const PW = 612, PH = 792, M = 48, CW = PW - M * 2, BOTTOM = PH - 56;
  const NAVY = [15, 42, 67], INK = [23, 32, 43], GRAY = [91, 107, 124], LINE = [223, 230, 238];
  const s = d.shopSnapshot || shop;
  const t = totalsFor(d);
  const veh = [d.vehicle.year, d.vehicle.make, d.vehicle.model].filter(Boolean).join(' ');
  const validThrough = fmtDate(d.createdAt + 30 * 24 * 3600 * 1000);
  const str = (v) => String(v == null ? '' : v);
  let y = 60;

  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 60; } };
  const rule = (color, w) => {
    doc.setDrawColor.apply(doc, color || LINE); doc.setLineWidth(w || 1);
    doc.line(M, y, PW - M, y); y += 14;
  };
  const secTitle = (label) => {
    ensure(30);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor.apply(doc, NAVY);
    doc.text(label.toUpperCase(), M, y); y += 16;
  };
  const para = (txt, size) => {
    if (!txt) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size || 10); doc.setTextColor.apply(doc, GRAY);
    doc.splitTextToSize(str(txt), CW).forEach((ln) => { ensure(15); doc.text(ln, M, y); y += 13; });
  };
  const kv = (label, value) => {
    if (value == null || value === '') return;
    const lines = doc.splitTextToSize(str(value), CW - 92);
    ensure(lines.length * 13 + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor.apply(doc, GRAY);
    doc.text(label + ':', M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor.apply(doc, INK);
    doc.text(lines, M + 82, y);
    y += lines.length * 13 + 2;
  };

  /* Header */
  if (s.logo) {
    try {
      const fmt = /data:image\/png/i.test(s.logo) ? 'PNG' : 'JPEG';
      doc.addImage(s.logo, fmt, PW - M - 56, 36, 56, 56);
    } catch (e) { /* logo must never break the report */ }
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor.apply(doc, NAVY);
  doc.text(str(s.name) || 'Wheel Repair Estimate', M, y); y += 20;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, GRAY);
  const contact = [s.phone, s.website].filter(Boolean).join('  ·  ');
  if (contact) { doc.text(contact, M, y); y += 14; }
  if (s.address) { doc.text(str(s.address), M, y); y += 14; }
  y += 2; rule();

  /* Meta */
  ensure(36);
  const meta = [['Estimate', d.number], ['Date', fmtDate(d.createdAt)], ['Valid through', validThrough]];
  const colW = CW / 3;
  meta.forEach((pair, i) => {
    const x = M + i * colW;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    doc.text(pair[0].toUpperCase(), x, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor.apply(doc, INK);
    doc.text(str(pair[1]), x, y + 15);
  });
  y += 34; rule();

  /* Customer + vehicle */
  secTitle('Customer');
  kv('Name', d.customer.name);
  kv('Phone', d.customer.phone);
  kv('Email', d.customer.email);
  y += 6;
  secTitle('Vehicle');
  kv('Vehicle', veh || '—');
  kv('VIN', d.vehicle.vin);
  kv('Mileage', d.vehicle.mileage);
  y += 6;

  /* Wheels */
  if (d.wheels.length) {
    secTitle('Wheels (' + d.wheels.length + ')');
    d.wheels.forEach((w, i) => {
      const dmg = DAMAGE_CATS.filter((c) => w.damage[c.id]).map((c) => c.label);
      ensure(20);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor.apply(doc, NAVY);
      doc.text('Wheel ' + (i + 1) + (w.position ? ' — ' + w.position : ''), M, y); y += 15;
      kv('Size', w.size);
      kv('Details', w.details);
      kv('Customer concern', w.concern);
      kv('Inspection notes', w.notes);
      if (dmg.length) kv('Damage', dmg.join(', '));
      y += 6;
    });
  }

  /* Photos */
  if (d.photos.length) {
    secTitle('Photos (' + d.photos.length + ')');
    const perRow = 2, gap = 12, iw = (CW - gap) / perRow, ih = 108;
    let col = 0;
    d.photos.slice(0, 6).forEach((p) => {
      try {
        if (col === 0) ensure(ih + 30);
        const x = M + col * (iw + gap);
        const fmt = /data:image\/png/i.test(p.dataUrl) ? 'PNG' : 'JPEG';
        doc.addImage(p.dataUrl, fmt, x, y, iw, ih, undefined, 'FAST');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
        const cap = doc.splitTextToSize(str(p.label || 'Wheel photo'), iw);
        doc.text(cap.slice(0, 2), x, y + ih + 12);
        col++;
        if (col >= perRow) { col = 0; y += ih + 30; }
      } catch (e) { /* a bad photo must never break the report */ }
    });
    if (col > 0) y += ih + 30;
  }

  /* Services */
  secTitle('Recommended work');
  ensure(24);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor.apply(doc, GRAY);
  doc.text('Service', M, y);
  doc.text('Price', PW - M, y, { align: 'right' });
  y += 6; rule(NAVY, 1.5);
  d.items.forEach((it) => {
    const r = parseMoneyToCents(it.priceStr);
    const cents = r.ok ? r.cents : (it.priceCents || 0);
    const lines = doc.splitTextToSize(str(it.desc) || '—', CW - 120);
    ensure(lines.length * 13 + 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, INK);
    doc.text(lines, M, y);
    doc.text(fmtMoney(cents), PW - M, y, { align: 'right' });
    y += lines.length * 13 + 4;
    doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5);
    doc.line(M, y, PW - M, y); y += 10;
  });

  /* Totals */
  const totRow = (label, cents, bold, size) => {
    ensure(22);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size || 11);
    doc.setTextColor.apply(doc, bold ? NAVY : GRAY);
    doc.text(label, M, y);
    doc.setTextColor.apply(doc, bold ? NAVY : INK);
    doc.text(fmtMoney(cents), PW - M, y, { align: 'right' });
    y += bold ? 20 : 17;
  };
  y += 4;
  totRow('Subtotal', t.subtotal);
  totRow('Tax (' + t.rate + '%)', t.tax);
  totRow('Estimated total', t.total, true, 14);

  /* Terms */
  y += 4;
  secTitle('Terms');
  para(d.terms || DEFAULT_TERMS);

  /* Signatures */
  y += 6;
  ensure(56);
  const sigY = y + 30;
  doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.75);
  doc.line(M, sigY, M + 220, sigY);
  doc.line(PW - M - 220, sigY, PW - M, sigY);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
  doc.text('Customer approval / Date', M, sigY + 14);
  doc.text('Authorized by / Date', PW - M - 220, sigY + 14);
  y = sigY + 34;

  /* Footers */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    doc.text('Thank you for trusting ' + (str(s.name) || 'our shop') + ' with your wheels.', M, PH - 34);
    doc.text('Estimate ' + str(d.number) + '  ·  Page ' + i + ' of ' + pages, PW - M, PH - 34, { align: 'right' });
  }
  return doc.output('blob');
}

function pdfFileFor(d) {
  return new File([buildPdf(d)], d.number + '.pdf', { type: 'application/pdf' });
}

/* Share the real PDF through the native share sheet (iPhone's reliable path),
   falling back to a straight download where sharing files isn't available. */
async function sharePdfReport() {
  if (!draft) { toast('Nothing to share yet.', 'err'); return; }
  let file;
  try { file = pdfFileFor(draft); }
  catch (e) { toast('Could not build the PDF.', 'err'); return; }
  if (navigator.canShare) {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'Estimate ' + draft.number, text: buildSummaryText(draft), files: [file] });
        toast('Shared.');
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  if (downloadBlob(file, file.name)) toast('PDF downloaded.');
  else toast('Could not share or download the PDF.', 'err');
}

async function shareEstimate() {
  await sharePdfReport();
}

async function copySummary() {
  const text = buildSummaryText(draft);
  try {
    await navigator.clipboard.writeText(text);
    toast('Text summary copied — paste it anywhere.');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Text summary copied — paste it anywhere.'); }
    catch (e2) { toast('Copy failed — your browser blocked it.', 'err'); }
    ta.remove();
  }
}

function printReport() {
  /* window.print() is a no-op inside iOS home-screen apps and unreliable in
     iOS Safari, so iPhones get the real PDF through the share sheet instead
     (which also offers Print, Save to Files, AirDrop, and messaging). */
  if (isIOS()) { sharePdfReport(); return; }
  window.print();
}

/* Real PDF download — replaces the old HTML file download. */
function downloadPdfReport() {
  if (!draft) { toast('Nothing to download yet.', 'err'); return; }
  let file;
  try { file = pdfFileFor(draft); }
  catch (e) { toast('Could not build the PDF.', 'err'); return; }
  if (downloadBlob(file, file.name)) toast('PDF downloaded.');
  else toast('Download failed — your browser blocked it.', 'err');
}

async function saveEstimate() {
  const checks = [
    ['customer', validateCustomer()], ['vehicle', validateVehicle()],
    ['wheels', validateWheels()], ['services', validateServices()], ['totals', validateTotals()],
  ];
  for (const [id, errs] of checks) {
    if (errs.length) {
      step = STEPS.findIndex((s) => s.id === id);
      render();
      showErrors(errs);
      toast('Fix the highlighted fields first.', 'err');
      return;
    }
  }
  draft.updatedAt = Date.now();
  draft.shopSnapshot = Object.assign({}, shop);
  const idx = estimates.findIndex((e) => e.id === draft.id);
  const entry = { id: draft.id, savedAt: Date.now(), data: JSON.parse(JSON.stringify(draft)) };
  if (idx >= 0) estimates[idx] = entry; else estimates.unshift(entry);
  store.set(LS_ESTIMATES, estimates);
  draft = null;
  store.del(LS_DRAFT);
  toast('Estimate ' + entry.data.number + ' saved.');
  navigate('saved');
}

/* ---------------- Global events ---------------- */
function ensureFileInputs() {
  if ($('#photoCameraInput')) return;
  const cam = document.createElement('input');
  cam.type = 'file'; cam.id = 'photoCameraInput';
  cam.accept = 'image/*'; cam.setAttribute('capture', 'environment'); cam.className = 'file-input-hidden';
  const lib = document.createElement('input');
  lib.type = 'file'; lib.id = 'photoLibraryInput';
  lib.accept = 'image/*'; lib.multiple = true; lib.className = 'file-input-hidden';
  const logo = document.createElement('input');
  logo.type = 'file'; logo.id = 'logoInput';
  logo.accept = 'image/png,image/jpeg,image/webp'; logo.className = 'file-input-hidden';
  const backup = document.createElement('input');
  backup.type = 'file'; backup.id = 'backupInput';
  backup.accept = '.json,application/json'; backup.className = 'file-input-hidden';
  const vinScan = document.createElement('input');
  vinScan.type = 'file'; vinScan.id = 'vinScanInput';
  vinScan.accept = 'image/*'; vinScan.setAttribute('capture', 'environment'); vinScan.className = 'file-input-hidden';
  document.body.append(cam, lib, logo, backup, vinScan);
  cam.addEventListener('change', () => { handlePhotoFiles(cam.files); cam.value = ''; });
  lib.addEventListener('change', () => { handlePhotoFiles(lib.files); lib.value = ''; });
  logo.addEventListener('change', async () => {
    if (logo.files && logo.files[0]) {
      try {
        const dataUrl = await processImageFile(logo.files[0], 512, 0.9, true);
        captureShopForm(); // keep typed-but-unsaved fields across the re-render
        shop.logo = dataUrl;
        store.set(LS_SHOP, shop);
        toast('Logo uploaded.');
        render();
      } catch (e) { toast('Could not read that image.', 'err'); }
    }
    logo.value = '';
  });
  backup.addEventListener('change', () => {
    if (backup.files && backup.files[0]) restoreBackupFile(backup.files[0]);
    backup.value = '';
  });
  vinScan.addEventListener('change', () => {
    if (vinScan.files && vinScan.files[0]) handleVinScanFile(vinScan.files[0]);
    vinScan.value = '';
  });
}

/* ---------------- Backup & restore ----------------
   Pure, testable helpers: buildBackupEnvelope(), validateBackup(),
   mergeBackupData(). DOM/download wrappers below them. */
const BACKUP_APP = 'wheel-shop-estimate-pro';
const BACKUP_FORMAT = 1;

function buildBackupEnvelope() {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: Date.now(),
    data: {
      shop: shop,
      estimates: estimates,
      draft: draft,
      counter: store.get(LS_COUNTER, 0) || 0,
    },
  };
}

function validateBackup(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-json' };
  if (obj.app !== BACKUP_APP) return { ok: false, reason: 'wrong-app' };
  if (obj.format !== BACKUP_FORMAT) return { ok: false, reason: 'wrong-format' };
  const d = obj.data;
  if (!d || typeof d !== 'object') return { ok: false, reason: 'no-data' };
  if (!Array.isArray(d.estimates)) return { ok: false, reason: 'no-estimates' };
  if (!d.shop || typeof d.shop !== 'object') return { ok: false, reason: 'no-shop' };
  return { ok: true };
}

/* Additive merge: imports estimates whose ids are missing here,
   skips ones already present, never deletes anything. Shop settings
   on this device are left untouched. Returns {added, skipped}. */
function mergeBackupData(data) {
  const seen = {};
  estimates.forEach((e) => { seen[e.id] = true; });
  let added = 0, skipped = 0;
  (data.estimates || []).forEach((e) => {
    if (!e || !e.id || seen[e.id]) { skipped++; return; }
    seen[e.id] = true;
    estimates.push({ id: e.id, savedAt: e.savedAt || Date.now(), data: e.data || e });
    added++;
  });
  const cur = store.get(LS_COUNTER, 0) || 0;
  const inc = data.counter || 0;
  if (inc > cur) store.set(LS_COUNTER, inc);
  if (data.draft && !draft) { draft = data.draft; store.set(LS_DRAFT, draft); }
  store.set(LS_ESTIMATES, estimates);
  return { added: added, skipped: skipped };
}

function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    return true;
  } catch (e) { return false; }
}

function backupFileName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return 'wheel-shop-estimate-pro-backup-' + d.getFullYear() + p(d.getMonth() + 1) +
    p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
}

function downloadBackup() {
  let json;
  try { json = JSON.stringify(buildBackupEnvelope()); }
  catch (e) { toast('Could not build the backup file.', 'err'); return; }
  const kb = Math.round(json.length / 1024);
  const ok = downloadBlob(new Blob([json], { type: 'application/json' }), backupFileName());
  if (ok) toast('Backup downloaded (' + kb + ' KB, ' + estimates.length + ' estimates). Keep it somewhere safe.');
  else toast('Download failed — your browser blocked it.', 'err');
}

function restoreBackupFile(file) {
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file.', 'err');
  reader.onload = async () => {
    let obj;
    try { obj = JSON.parse(reader.result); }
    catch (e) { toast('That file is not a valid backup — nothing was changed.', 'err'); return; }
    const v = validateBackup(obj);
    if (!v.ok) {
      const msg = v.reason === 'wrong-app'
        ? 'That backup is from a different app — nothing was changed.'
        : 'That backup file is damaged or from an incompatible version — nothing was changed.';
      toast(msg, 'err');
      return;
    }
    const n = (obj.data.estimates || []).length;
    const shopName = obj.data.shop.name || 'Unnamed shop';
    const when = fmtDateTime(obj.exportedAt);
    const ok = await confirmDialog({
      title: 'Restore this backup?',
      body: 'Backup from ' + shopName + ' (' + when + ') with ' + n + ' estimate' + (n === 1 ? '' : 's') +
        '. Estimates missing from this device will be added; nothing here will be deleted or overwritten. Your current shop settings stay as they are.',
      confirmText: 'Restore backup',
    });
    if (!ok) return;
    const r = mergeBackupData(obj.data);
    if (idbOk) { await migratePhotoBlobs(); await hydratePhotos(); }
    render();
    toast('Restore complete: ' + r.added + ' added' + (r.skipped ? ', ' + r.skipped + ' already here skipped' : '') + '.');
  };
  reader.readAsText(file);
}
/* Read the shop form into `shop` without validating or saving, so a
   re-render (e.g. after a logo upload) never wipes typed-but-unsaved fields. */
function captureShopForm() {
  const form = $('#shopForm');
  if (!form) return;
  shop.name = $('#shop-name', form).value.trim();
  shop.phone = $('#shop-phone', form).value.trim();
  shop.website = $('#shop-website', form).value.trim();
  shop.address = $('#shop-address', form).value.trim();
  shop.taxRate = $('#shop-tax', form).value.trim();
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) {
    if (tab.dataset.route === 'wizard') { await startWizard(true); return; }
    navigate(tab.dataset.route);
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;

  if (a === 'go') navigate(btn.dataset.route);
  else if (a === 'new-estimate') await startWizard(false);
  else if (a === 'resume-draft') { step = 0; navigate('wizard'); }
  else if (a === 'wiz-back') { if (step > 0) { step--; render(); window.scrollTo(0, 0); } }
  else if (a === 'wiz-next') {
    const errs = validateStep(STEPS[step].id);
    if (!showErrors(errs)) { markDirty(); return; }
    markDirty();
    if (step < STEPS.length - 1) { step++; render(); window.scrollTo(0, 0); }
  }
  else if (a === 'wiz-goto') {
    const target = parseInt(btn.dataset.step, 10);
    if (target < step) { step = target; render(); window.scrollTo(0, 0); }
    else if (target > step) {
      const errs = validateStep(STEPS[step].id);
      if (!showErrors(errs)) return;
      step = target; render(); window.scrollTo(0, 0);
    }
  }
  else if (a === 'wheel-add') { draft.wheels.push(newWheel()); markDirty(); render(); }
  else if (a === 'wheel-remove') {
    const ok = await confirmDialog({ title: 'Remove this wheel?', body: 'Its details, damage marks, and notes will be removed from this estimate.', confirmText: 'Remove wheel', danger: true });
    if (ok) { draft.wheels = draft.wheels.filter((w) => w.id !== btn.dataset.id); markDirty(); render(); }
  }
  else if (a === 'photo-take') $('#photoCameraInput').click();
  else if (a === 'photo-choose') $('#photoLibraryInput').click();
  else if (a === 'photo-remove') {
    const ok = await confirmDialog({ title: 'Remove this photo?', body: 'The photo will be removed from this estimate.', confirmText: 'Remove photo', danger: true });
    if (ok) { const goneId = btn.dataset.id; dropPhotoBlobs(draft.photos.filter((p) => p.id === goneId)); draft.photos = draft.photos.filter((p) => p.id !== goneId); markDirty(); render(); toast('Photo removed.'); }
  }
  else if (a === 'photo-view') {
    const p = draft.photos.find((x) => x.id === btn.dataset.id);
    if (p) showLightbox(p);
  }
  else if (a === 'preset-add') {
    const p = PRESETS.find((x) => x.id === btn.dataset.id);
    if (p) { addItem(p.label, p.priceCents); toast(p.label + ' added.'); }
  }
  else if (a === 'item-add') addItem('', null);
  else if (a === 'item-remove') {
    draft.items = draft.items.filter((it) => it.id !== btn.dataset.id);
    markDirty(); render();
  }
  else if (a === 'review-fix') {
    const map = [
      ['customer', validateCustomer()], ['vehicle', validateVehicle()],
      ['wheels', validateWheels()], ['services', validateServices()], ['totals', validateTotals()],
    ];
    const bad = map.find(([, errs]) => errs.length);
    if (bad) { step = STEPS.findIndex((s) => s.id === bad[0]); render(); showErrors(bad[1]); }
  }
  else if (a === 'save-estimate') saveEstimate();
  else if (a === 'share') shareEstimate();
  else if (a === 'report-download') downloadPdfReport();
  else if (a === 'vin-decode') decodeVin();
  else if (a === 'vin-scan') scanVin();
  else if (a === 'copy-summary') copySummary();
  else if (a === 'print') printReport();
  else if (a === 'logo-pick') $('#logoInput').click();
  else if (a === 'backup-download') downloadBackup();
  else if (a === 'backup-pick') $('#backupInput').click();
  else if (a === 'logo-remove') {
    captureShopForm();
    shop.logo = ''; store.set(LS_SHOP, shop); render(); toast('Logo removed.');
  }
  else if (a === 'saved-open') {
    const entry = estimates.find((x) => x.id === btn.dataset.id);
    if (!entry) return;
    if (draft && draftHasContent(draft)) {
      const ok = await confirmDialog({ title: 'Open saved estimate?', body: 'Your current draft (' + draft.number + ') will be discarded.', confirmText: 'Discard draft & open', danger: true });
      if (!ok) return;
    }
    draft = JSON.parse(JSON.stringify(entry.data));
    draft.shopSnapshot = undefined;
    store.set(LS_DRAFT, draft);
    step = 0;
    navigate('wizard');
  }
  else if (a === 'saved-dup') {
    const entry = estimates.find((x) => x.id === btn.dataset.id);
    if (!entry) return;
    const copy = JSON.parse(JSON.stringify(entry.data));
    copy.id = uid();
    copy.number = nextEstimateNumber();
    copy.createdAt = Date.now(); copy.updatedAt = Date.now();
    copy.shopSnapshot = undefined;
    estimates.unshift({ id: copy.id, savedAt: Date.now(), data: copy });
    store.set(LS_ESTIMATES, estimates);
    render(); toast('Duplicated as ' + copy.number + '.');
  }
  else if (a === 'saved-del') {
    const entry = estimates.find((x) => x.id === btn.dataset.id);
    if (!entry) return;
    const ok = await confirmDialog({
      title: 'Delete ' + entry.data.number + '?',
      body: 'This saved estimate will be permanently deleted from this device.',
      confirmText: 'Delete', danger: true,
    });
    if (ok) {
      const gone = estimates.find((x) => x.id === btn.dataset.id);
      if (gone && gone.data) dropPhotoBlobs(gone.data.photos);
      estimates = estimates.filter((x) => x.id !== btn.dataset.id);
      store.set(LS_ESTIMATES, estimates);
      render(); toast('Estimate deleted.');
    }
  }
});

async function startWizard(fromTab) {
  const has = draft && draftHasContent(draft);
  if (has && !fromTab) {
    const ok = await confirmDialog({
      title: 'Start a new estimate?',
      body: 'Your current draft (' + draft.number + ') has unsaved work. Starting new will discard it.',
      confirmText: 'Discard & start new', cancelText: 'Keep editing', danger: true,
    });
    if (!ok) return;
    dropPhotoBlobs(draft.photos);
    draft = newEstimate();
    store.set(LS_DRAFT, draft);
  } else if (!has) {
    draft = newEstimate();
    store.set(LS_DRAFT, draft);
  }
  step = 0;
  navigate('wizard');
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest && t.closest('#shopForm')) return; // shop form saves on submit
  if (!draft) return;
  if (t.matches('[data-field]')) {
    setDeep(draft, t.dataset.field, t.value);
    t.removeAttribute('aria-invalid');
    const err = document.getElementById(t.id + '-err');
    if (err) { err.hidden = true; err.textContent = ''; }
    markDirty();
    if (t.dataset.field === 'taxRate' && STEPS[step] && STEPS[step].id === 'totals') {
      const box = t.closest('.card');
      if (box) {
        const tb = box.querySelector('.totals-box');
        if (tb) {
          const tt = totalsFor(draft);
          tb.innerHTML =
            '<div class="totals-row"><span>Subtotal</span><span>' + fmtMoney(tt.subtotal) + '</span></div>' +
            '<div class="totals-row"><span>Tax (' + tt.rate + '%)</span><span>' + fmtMoney(tt.tax) + '</span></div>' +
            '<div class="totals-row grand"><span>Estimated total</span><span>' + fmtMoney(tt.total) + '</span></div>';
        }
      }
    }
  } else if (t.matches('[data-wheel]') && t.dataset.wfield) {
    const w = draft.wheels.find((x) => x.id === t.dataset.wheel);
    if (w) { w[t.dataset.wfield] = t.value; markDirty(); }
  } else if (t.matches('[data-photo-label]')) {
    const p = draft.photos.find((x) => x.id === t.dataset.photoLabel);
    if (p) { p.label = t.value; markDirty(); }
  } else if (t.matches('[data-item-desc]')) {
    const it = draft.items.find((x) => x.id === t.dataset.itemDesc);
    if (it) { it.desc = t.value; markDirty(); }
  } else if (t.matches('[data-item-price]')) {
    const it = draft.items.find((x) => x.id === t.dataset.itemPrice);
    if (it) { it.priceStr = t.value; markDirty(); }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.closest && t.closest('#shopForm')) return;
  if (!draft) return;
  if (t.matches('[data-damage]')) {
    const w = draft.wheels.find((x) => x.id === t.dataset.wheel);
    if (w) { w.damage[t.dataset.damage] = t.checked; markDirty(); }
  }
  if (t.matches('[data-wheel]') && t.dataset.wfield) {
    const w = draft.wheels.find((x) => x.id === t.dataset.wheel);
    if (w) { w[t.dataset.wfield] = t.value; markDirty(); }
  }
  if (t.matches('[data-item-price]')) {
    const it = draft.items.find((x) => x.id === t.dataset.itemPrice);
    if (it) {
      const r = parseMoneyToCents(it.priceStr);
      const err = document.getElementById(t.id + '-err');
      if (!r.ok && it.priceStr.trim() !== '') {
        t.setAttribute('aria-invalid', 'true');
        if (err) { err.textContent = 'Enter a valid price, numbers only (e.g. 149.99).'; err.hidden = false; }
      } else {
        t.removeAttribute('aria-invalid');
        if (err) { err.hidden = true; err.textContent = ''; }
        if (r.ok) it.priceCents = r.cents;
        markDirty();
        const tb = $('#servicesTotals');
        if (tb) {
          const tt = totalsFor(draft);
          tb.innerHTML =
            '<div class="totals-row"><span>Subtotal</span><span>' + fmtMoney(tt.subtotal) + '</span></div>' +
            '<div class="hint">Tax is set on the next step.</div>';
        }
      }
    }
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'shopForm') { e.preventDefault(); saveShopFromForm(e.target); }
});

/* ---------------- PWA ---------------- */
let deferredPrompt = null;
function isIOSDevice() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    !!window.navigator.standalone;
}
function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const b = $('#installBtn');
    if (b) { b.hidden = false; b.textContent = 'Install app'; }
  });
  // iOS Safari never fires beforeinstallprompt — offer the manual
  // Share → Add to Home Screen path instead of a dead button.
  if (!isStandalone() && isIOSDevice() && !deferredPrompt) {
    const b = $('#installBtn');
    if (b) { b.hidden = false; b.textContent = 'Install app'; }
  }
  const b = $('#installBtn');
  if (b) b.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      b.hidden = true;
      return;
    }
    if (isIOSDevice() && !isStandalone()) {
      confirmDialog({
        title: 'Install on iPhone',
        body: 'Tap the Share button in Safari (the square with an arrow), then choose "Add to Home Screen". The app will open full-screen and work offline.',
        confirmText: 'Got it',
        cancelText: 'Close',
      });
    }
  });
}

/* ---------------- Theme (light / dark) ---------------- */
function initTheme() {
  const KEY = 'wse-theme';
  const root = document.documentElement;
  const apply = (t) => {
    root.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    const b = $('#themeBtn');
    if (b) b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  };
  let initial = 'light';
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'dark' || s === 'light') initial = s;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) initial = 'dark';
  } catch (e) {}
  apply(initial);
  const b = $('#themeBtn');
  if (b) b.addEventListener('click', () => {
    apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
}

/* One-time migration: photos saved before v2.3 kept their dataUrl inside
   localStorage. Move each blob to IndexedDB; the next store.set() strips it.
   Idempotent — only photos that still carry an embedded dataUrl are moved. */
async function migratePhotoBlobs() {
  if (!idbOk) return;
  const jobs = [];
  const migrateOne = (p) => {
    if (p && p.id && typeof p.dataUrl === 'string' && p.dataUrl) {
      jobs.push(photoDB.put(p.id, p.dataUrl).catch(() => null));
    }
  };
  if (draft) (draft.photos || []).forEach(migrateOne);
  eachEstimatePhoto(migrateOne);
  await Promise.all(jobs);
  if (jobs.length) {
    if (draft) store.set(LS_DRAFT, draft);
    store.set(LS_ESTIMATES, estimates);
  }
}

/* Re-attach photo blobs to the in-memory draft/estimates after boot (or
   after a backup restore). Rendering and PDF export read p.dataUrl from
   memory; localStorage only ever holds {id,label,ts}. */
async function hydratePhotos() {
  if (!idbOk) return;
  const jobs = [];
  const hydrateOne = (p) => {
    if (p && p.id && !p.dataUrl) {
      jobs.push(photoDB.get(p.id).then((d) => { if (d) p.dataUrl = d; }));
    }
  };
  if (draft) (draft.photos || []).forEach(hydrateOne);
  eachEstimatePhoto(hydrateOne);
  await Promise.all(jobs);
}

/* ---------------- Init ---------------- */
async function init() {
  ensureFileInputs();
  initTheme();
  initPWA();
  try { idbOk = await photoDB.open(); } catch (e) { idbOk = false; }
  if (idbOk) {
    await migratePhotoBlobs();
    await hydratePhotos();
  }
  if (!draft) draft = null;
  render();
}
document.addEventListener('DOMContentLoaded', init);
