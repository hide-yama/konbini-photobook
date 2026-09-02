/* 写真集エディタ — ブラウザ完結版
   写真はブラウザの外に出ません。PDF生成もすべて手元で行います。 */
'use strict';

const MM = 72 / 25.4;                    // 1mm = 2.8346pt
/* 90度単位に丸めて 0/90/180/270 にする。回転まわりで先に必要になるのでここに置く */
const norm360 = d => ((Math.round(d / 90) * 90 % 360) + 360) % 360;
const CFG = JSON.parse(document.getElementById('cfg-data').textContent);
const TPL = JSON.parse(document.getElementById('tpl-data').textContent);
/* ── 冊子サイズと向き ──
   面付けはマルチコピー機の「小冊子プリント」がやるので、こちらは仕上がりサイズで組む。
   店頭では paper の用紙（仕上がりの2倍の紙）を選ぶ。
   縦 = 左とじ（横にめくる） / 横 = 上とじ（上にめくる）。
   機械のボタンはどちらも「左とじ / 上とじ」で、ページの向きで機械が判断する。 */
const BOOK = {
  A4: { portrait: [210, 297], landscape: [297, 210], paper: 'A3' },
  B5: { portrait: [182, 257], landscape: [257, 182], paper: 'B4' },
};
const ORIENT = {
  portrait:  { design: [210, 297], fill: 'portrait-fill', key: 'templates',
               pairs: 'rotate_pairs',           label: '縦',
               toji: b => (b === 'right' ? '右とじ' : '左とじ') },
  landscape: { design: [297, 210], fill: 'land-fill',     key: 'templates_landscape',
               pairs: 'rotate_pairs_landscape', label: '横',
               toji: b => (b === 'right' ? '下とじ' : '上とじ') },
};

let BOOK_NAME = BOOK[CFG.book] ? CFG.book : 'B5';
let ORIENT_NAME = ORIENT[CFG.orientation] ? CFG.orientation : 'portrait';
let PW, PH, T, PAIRS, FILL_TPL;

/* 自動で回すときの角度（時計回り）。90 = 写真の天がページ右を向く */
const ROT_DEG = norm360(CFG.rotate_degrees ?? 90);

/* 後ろ側のページか。縦なら右ページ、横なら下ページ。
   左とじ(上とじ)では奇数がそちら側になり、右とじ(下とじ)では逆。 */
const isFarPage = no => (CFG.binding === 'right') ? no % 2 === 0 : no % 2 === 1;
const isRightPage = isFarPage;              // 旧名。呼び出し側の互換のため

/** 版面をいまの仕上がりサイズへ比例縮小する。
    x=0 と x=DESIGN_W を 0 と PW にきっちり写すので、隣り合うページの絵は端で揃う。 */
function scaleTemplates(src, pw, ph, dw, dh) {
  const kx = pw / dw, ky = ph / dh;
  if (kx === 1 && ky === 1) return src;
  const out = {};
  for (const [name, t] of Object.entries(src)) {
    out[name] = {
      ...t,
      images: (t.images || []).map(f => ({ ...f,
        x: f.x * kx, y: f.y * ky, w: f.w * kx, h: f.h * ky })),
      texts: (t.texts || []).map(s => ({ ...s,
        x: s.x * kx, y: s.y * ky,
        ...(s.w != null ? { w: s.w * kx } : {}),
        size: (s.size ?? 9) * ky,
        ...(s.leading != null ? { leading: s.leading * ky } : {}) })),
    };
  }
  return out;
}

function setLayout(book, orient) {
  BOOK_NAME = BOOK[book] ? book : BOOK_NAME;
  ORIENT_NAME = ORIENT[orient] ? orient : ORIENT_NAME;
  const o = ORIENT[ORIENT_NAME];
  [PW, PH] = BOOK[BOOK_NAME][ORIENT_NAME];
  FILL_TPL = o.fill;
  PAIRS = TPL[o.pairs] || {};
  T = scaleTemplates(TPL[o.key] || TPL.templates, PW, PH, o.design[0], o.design[1]);
  document.body.classList.toggle('landscape', ORIENT_NAME === 'landscape');
}
setLayout(BOOK_NAME, ORIENT_NAME);

/** いまの向きで、この写真を回す必要があるか（縦ページなら横写真、横ページなら縦写真） */
function autoRotFor(p) {
  if (!p) return 0;
  const need = ORIENT_NAME === 'landscape' ? p.orientation === 'portrait'
                                           : p.orientation === 'landscape';
  return need ? ROT_DEG : 0;
}

function onBookChange(v) { setLayout(v, ORIENT_NAME); renderAll(); }

function onOrientChange(v) {
  const before = ORIENT_NAME;
  setLayout(BOOK_NAME, v);
  if (before !== ORIENT_NAME && S.pages.length) {
    autoPlan();                      // 版面の名前ごと入れ替わるので台割を組み直す
    toast(`${ORIENT[ORIENT_NAME].label}ページで組み直しました`);
  } else {
    renderAll();
  }
}

/* 画面のセレクタを config.json の既定値に合わせる。
   これをしないと config が B4 でも画面はA3を指したままになる */
function syncControls() {
  loadBookInfo();
  setTab(document.body.dataset.tab || 'grid');
  const p = $('#book'); if (p) p.value = BOOK_NAME;
  const or = $('#orient'); if (or) or.value = ORIENT_NAME;
}

const S = {
  photos: [], pages: [], sel: -1,
  pickPages: false, markedPages: new Set(), lastMark: null,   // 台割の複数選択
  pickPhotos: false, markedPhotos: new Set(),                 // 写真トレイの複数選択
  prev: [], prevAt: 0,                                        // 見開きプレビュー
  picker: null,                                               // 写真を選ぶ一覧を開いている枠
};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ═══════════ 写真の読み込み ═══════════ */

const PREVIEW_MAX = 1800;               // 画面表示用に縮小しておく上限

async function importFiles(fileList) {
  const files = [...fileList].filter(f => /\.(jpe?g|png|tiff?|webp)$/i.test(f.name));
  if (!files.length) { toast('画像が見つかりませんでした'); return; }
  files.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const bar = $('#progress');
  bar.style.display = '';
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    bar.textContent = `読み込み中 ${i + 1}/${files.length}  ${f.name}`;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const sc = Math.min(1, PREVIEW_MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * sc));
      c.height = Math.max(1, Math.round(bmp.height * sc));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      S.photos.push({
        name: f.name, file: f, w: bmp.width, h: bmp.height,
        orientation: bmp.height > bmp.width ? 'portrait'
          : (bmp.height === bmp.width ? 'square' : 'landscape'),
        prev: c, thumb: makeThumb(c),
      });
      bmp.close();
    } catch (e) { console.warn('読み込み失敗', f.name, e); }
    if (i % 4 === 3) await new Promise(r => setTimeout(r));
  }
  bar.style.display = 'none';
  renderTray();
  if (!S.pages.length) autoPlan();
  toast(`${S.photos.length}枚を読み込みました`);
}

function makeThumb(src) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 200 / Math.max(src.width, src.height));
  c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

const photoBy = n => S.photos.find(p => p.name === n);

/* 書き出し用に、必要な画素数だけ再デコードする（元ファイルから読み直す） */
async function decodeAt(photo, needW, needH) {
  const full = Math.max(photo.w, photo.h);
  const need = Math.max(needW, needH);
  if (need <= Math.max(photo.prev.width, photo.prev.height)) return photo.prev;
  const opt = { imageOrientation: 'from-image' };
  if (need < full) { opt.resizeWidth = Math.round(photo.w * need / full); opt.resizeQuality = 'high'; }
  const bmp = await createImageBitmap(photo.file, opt);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/* ═══════════ 版面の計算（プレビューと書き出しで共通） ═══════════ */


/** ページの回転角を時計回りの度数で返す。
    古い 'cw' / 'ccw' 表記も読めるようにしてある */
function pageRotation(pg) {
  const r = pg && pg.rotate;
  if (typeof r === 'number') return norm360(r);
  if (r === 'cw') return 90;
  if (r === 'ccw') return 270;
  return 0;
}

/** rot は数値（時計回りの度数）か、テンプレート側の 'cw'/'ccw'/'auto-cw'/'auto-ccw' */
function applyRotate(src, rot) {
  if (!rot) return src;
  let deg;
  if (typeof rot === 'number') {
    deg = norm360(rot);
  } else {
    const s = String(rot), wide = src.width > src.height;
    if (!(s === 'cw' || s === 'ccw' || (s.startsWith('auto') && wide))) return src;
    deg = s.endsWith('ccw') ? 270 : 90;   // ccw = 反時計90 = 時計270
  }
  if (!deg) return src;
  const swap = deg === 90 || deg === 270;
  const c = document.createElement('canvas');
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2);
  x.rotate(deg * Math.PI / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function cropSrc(src, cr) {
  if (!cr) return src;
  const c = document.createElement('canvas');
  const x0 = Math.round(cr[0] * src.width), y0 = Math.round(cr[1] * src.height);
  c.width = Math.max(1, Math.round((cr[2] - cr[0]) * src.width));
  c.height = Math.max(1, Math.round((cr[3] - cr[1]) * src.height));
  c.getContext('2d').drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

/** テキストの上端(mm)。anchor:"bottom" のときは、増えた行のぶん上へ伸ばす。
    こうしないと、行が増えたときに下にあるサブタイトルへ食い込む。 */
function textTopMm(ts, r) {
  if (ts.rotate) return ts.y - r.hMm;
  const up = ts.anchor === 'bottom' ? (r.lines - 1) * r.leadMm : 0;
  return ts.y - ts.size * (25.4 / 72) - up;
}

/** 枠に収めたときの実寸(mm)と、切り出し矩形を返す */
/* 切り抜きの調整。z=拡大率（1が枠にちょうど）、x/y=枠の中心に来る元画像の位置（0〜1） */
const CROP0 = { z: 1, x: 0.5, y: 0.5 };
const cropOf = (pg, slot) => (pg && pg.crops && pg.crops[slot]) || CROP0;

function setCrop(pg, slot, v) {
  pg.crops = pg.crops || [];
  pg.crops[slot] = v;
}

function clearCrop(pg, slot) {
  if (!pg || !pg.crops) return;
  delete pg.crops[slot];
  if (!pg.crops.some(v => v)) delete pg.crops;
}

/** 枠に収めたときの実寸(mm)と、元画像から切り出す矩形を返す。
    adj で拡大率と中心をずらせる。枠から画像がはみ出さないよう端で止める。 */
function fitBox(sw, sh, fw, fh, mode, adj) {
  if (mode === 'cover') {
    const z = Math.max(1, (adj && adj.z) || 1);
    const s = Math.max(fw / sw, fh / sh) * z;
    const vw = fw / s, vh = fh / s;                 // 元画像から使う範囲
    const fx = (adj && adj.x != null) ? adj.x : 0.5;
    const fy = (adj && adj.y != null) ? adj.y : 0.5;
    const sx = Math.max(0, Math.min(sw - vw, fx * sw - vw / 2));
    const sy = Math.max(0, Math.min(sh - vh, fy * sh - vh / 2));
    return { drawW: fw, drawH: fh, sx, sy, sw: vw, sh: vh };
  }
  const s = Math.min(fw / sw, fh / sh);
  return { drawW: sw * s, drawH: sh * s, sx: 0, sy: 0, sw, sh };
}

/** その枠の回転角。枠ごとの指定があればそれ、無ければページ全体の指定に従う。
    2枚組の版面では写真ごとに向きを変えたいので、枠ごとに持てるようにしてある。 */
function slotRotation(pg, slot) {
  const r = pg && pg.rots && pg.rots[slot];
  return r == null ? pageRotation(pg) : norm360(r);
}

function setSlotRot(pg, slot, deg) {
  pg.rots = pg.rots || [];
  pg.rots[slot] = norm360(deg);          // 0も明示的に持つ（ページ指定を打ち消すため）
}

/** 回転と src_crop を適用したあとの元画像。drawPage と当たり判定で同じものを使う */
function preparedSrc(p, pg, fr) {
  const slot = fr.slot || 0;
  return cropSrc(applyRotate(p.prev, slotRotation(pg, slot) || fr.rotate), fr.src_crop);
}

/** ページ上の位置(mm)にある、切り抜きを動かせる枠を返す */
function frameAt(pg, t, pageNo, mx, my) {
  const { dx, dy } = gutterShift(t, pageNo);
  for (const fr of (t.images || [])) {
    if ((fr.fit || 'contain') !== 'cover') continue;       // contain は切り抜かないので対象外
    const nm = (pg.photos || [])[fr.slot || 0];
    if (!nm || !photoBy(nm)) continue;
    const x0 = fr.x + dx, y0 = fr.y + dy;
    if (mx >= x0 && mx <= x0 + fr.w && my >= y0 && my <= y0 + fr.h) return fr;
  }
  return null;
}

/** その版面に、切り抜きを動かせる枠があるか */
const hasCropFrame = (pg, t) => !!(t && (t.images || []).some(fr =>
  (fr.fit || 'contain') === 'cover' && (pg.photos || [])[fr.slot || 0] &&
  photoBy((pg.photos || [])[fr.slot || 0])));

/** ノド逃げ。縦ページは左右へ、横ページは上下へ逃がす。
    後ろ側のページ（右頁／下頁）はノドが手前側にあるので + へ動かす。 */
function gutterShift(t, pageNo) {
  const hg = (CFG.gutter_mm || 0) / 2;
  if (!hg || t.gutter === false) return { dx: 0, dy: 0 };
  const d = isFarPage(pageNo) ? hg : -hg;
  return ORIENT_NAME === 'landscape' ? { dx: 0, dy: d } : { dx: d, dy: 0 };
}

/* ═══════════ 表紙の文字ブロック ═══════════
   タイトルとサブタイトルはひと組として四隅のどこかに置く。
   版面の座標ではなくページの寸法から計算するので、冊子サイズや向きが変わっても追従する。 */

const COVER_POS = { tl: '左上', tr: '右上', bl: '左下', br: '右下' };

/** ページ端からの余白（mm）。A4縦の18mmを基準に、辺の長さで比例させる */
const coverMargin = () => ({ x: PW * (18 / 210), y: PH * (18 / 297) });

/** 文字の下に敷く帯（座布団）。ページの端から伸びて、文字を包む。
    off なら null。文字が空のときも敷かない。 */
function coverBandSpec(ti, su, titleText, subText) {
  if (!CFG.band) return null;
  const PT = 25.4 / 72;
  const te = titleText ? textExtent(ti, titleText) : null;
  const se = (su && subText) ? textExtent(su, subText) : null;
  const maxW = Math.max(te ? te.wMm : 0, se ? se.wMm : 0);
  if (!maxW) return null;

  const m = coverMargin();
  const padX = ti.size * PT * 0.55, padY = ti.size * PT * 0.45;
  const len = m.x + maxW + padX;                       // 端からの伸び
  const toRight = (COVER_POS[CFG.cover_pos] ? CFG.cover_pos : 'bl')[1] === 'r';

  /* 文字の上端と下端 */
  const box = (sp, ex) => {
    const up = sp.anchor === 'bottom' ? (ex.lines - 1) * sp.leading * PT : 0;
    const top = sp.y - sp.size * PT - up;
    return [top, top + (ex.lines - 1) * sp.leading * PT + sp.size * PT * 1.25];
  };
  let top = Infinity, bottom = -Infinity;
  for (const [sp, ex] of [[ti, te], [su, se]]) {
    if (!sp || !ex) continue;
    const [a, b] = box(sp, ex);
    top = Math.min(top, a); bottom = Math.max(bottom, b);
  }
  return { x: toRight ? PW - len : 0, y: top - padY, w: len, h: (bottom - top) + padY * 2,
           color: CFG.band_color || '#000000',
           opacity: Math.max(0, Math.min(1, (CFG.band_opacity == null ? 70 : +CFG.band_opacity) / 100)) };
}

/** タイトル／サブタイトルの位置・大きさ・色を、いまの設定から決めて上書きする。
    ti, su は版面側の定義（既定値として使う）。 */
function coverBlockSpecs(ti, su, titleText) {
  const pos = COVER_POS[CFG.cover_pos] ? CFG.cover_pos : 'bl';
  const toRight = pos[1] === 'r', toTop = pos[0] === 't';
  const m = coverMargin();
  const w = PW - m.x * 2;
  const align = toRight ? 'right' : 'left';
  const PT = 25.4 / 72;

  const tiSize = +CFG.size_title || ti.size;
  const suSize = su ? (+CFG.size_subtitle || su.size) : 0;
  const tiLead = tiSize * 1.3, suLead = suSize * 1.4;      // 行送りは字送りから決める
  /* ベースライン間（mm）。字高にそのまま比例させると、タイトルを大きくしたときに
     空きが一緒に膨らんで離れて見える。目に見える空きがだいたい一定に保たれるよう、
     「タイトルの下ヒゲ」「サブタイトルの字面」「わずかな余白」を足して決める。 */
  const tiMm = tiSize * PT, suMm = suSize * PT;
  const gap = tiMm * 0.20        // タイトルのベースラインから下へ出る分
            + suMm * 0.72        // サブタイトルのベースラインから上の字面
            + (0.6 + tiMm * 0.08); // 見た目の空き。大きくしても控えめにしか増やさない

  const out = { ...ti, x: m.x, w, align, size: tiSize, leading: tiLead,
                color: CFG.color_title || ti.color };
  let sub = null;

  if (toTop) {
    /* 上寄せ：タイトルは下へ伸ばし、サブタイトルはその下に付いていく */
    out.anchor = 'top';
    out.y = m.y + tiSize * PT;
    if (su) {
      const n = countLines({ ...out, text: titleText || 'あ' }, titleText || 'あ');
      sub = { ...su, x: m.x, w, align, size: suSize, leading: suLead,
              color: CFG.color_subtitle || su.color,
              y: out.y + (n - 1) * tiLead * PT + gap };
    }
  } else {
    /* 下寄せ：サブタイトルを下端に固定し、タイトルは上へ伸ばす */
    out.anchor = 'bottom';
    if (su) {
      sub = { ...su, x: m.x, w, align, size: suSize, leading: suLead,
              color: CFG.color_subtitle || su.color, y: PH - m.y };
      out.y = sub.y - gap;
    } else {
      out.y = PH - m.y;
    }
  }
  return { title: out, subtitle: sub };
}

/* この版面が使っている差し込み文字（title / subtitle / credit）を拾う */
const TEXT_FIELDS = ['title', 'subtitle', 'credit'];
const TEXT_LABEL = { title: 'タイトル', subtitle: 'サブタイトル', credit: 'クレジット' };
function textFieldsOf(t) {
  const src = (t.texts || []).map(x => String(x.content || '')).join(' ');
  return TEXT_FIELDS.filter(k => src.includes('{' + k + '}'));
}
const isHidden = (pg, k) => (pg.hide || []).includes(k);

/** 表紙の文字と帯をまとめて計算する。文字（pageTexts）と帯（pageBand）が
    別々に計算すると必ずずれるので、入口はここ1つにする。 */
function coverLayout(t, vals) {
  if (!t || !t.cover_block) return null;
  const ti0 = (t.texts || []).find(x => String(x.content).includes('{title}'));
  if (!ti0) return null;
  const su0 = (t.texts || []).find(x => String(x.content).includes('{subtitle}'));
  const spec = coverBlockSpecs(withChosenFont(ti0, ti0.content),
                               su0 && withChosenFont(su0, su0.content), vals.title);
  return { ...spec, band: coverBandSpec(spec.title, spec.subtitle, vals.title, vals.subtitle) };
}

/** そのページに敷く帯。写真の上・文字の下に描く */
function pageBand(pg, t) {
  const hide = new Set(pg.hide || []);
  const cv = coverLayout(t, {
    title: hide.has('title') ? '' : (pg.title || CFG.title || ''),
    subtitle: hide.has('subtitle') ? '' : (pg.subtitle || CFG.subtitle || ''),
  });
  return cv && cv.band;
}

function pageTexts(pg, t, pageNo) {
  const hide = new Set(pg.hide || []);
  const pick = (k, v) => (hide.has(k) ? '' : v);
  const vals = {
    title: pick('title', pg.title || CFG.title || ''),
    subtitle: pick('subtitle', pg.subtitle || CFG.subtitle || ''),
    credit: pick('credit', pg.credit || CFG.credit || ''),
    caption: pg.caption || '', caption2: pg.caption2 || '', pageno: String(pageNo),
  };
  const out = [];
  let list = [...(t.texts || [])];

  /* 表紙は、版面の座標ではなく設定（四隅・大きさ・色）で置き直す */
  const cv = coverLayout(t, vals);
  if (cv) {
    const ti = list.find(x => String(x.content).includes('{title}'));
    const su = list.find(x => String(x.content).includes('{subtitle}'));
    list = list.map(x => (x === ti ? cv.title : (x === su && cv.subtitle ? cv.subtitle : x)));
  }
  if (CFG.page_numbers && pageNo >= (CFG.page_number_start || 3) && t.nombre !== false) {
    const sm = CFG.safe_margin_mm || 7;
    const k = PH / ORIENT[ORIENT_NAME].design[1], far = isFarPage(pageNo);
    if (ORIENT_NAME === 'landscape') {
      /* 小口は上下。下頁なら下、上頁なら上に置く */
      list.push({ content: '{pageno}', x: PW / 2 - 10 * k, y: far ? PH - sm : sm + 6 * k,
                  w: 20 * k, size: 7.5 * k, font: 'sans', align: 'center', color: '#999999' });
    } else {
      list.push({ content: '{pageno}', x: far ? PW - sm - 20 * k : sm, y: PH - 6 * k,
                  w: 20 * k, size: 7.5 * k, font: 'sans', align: far ? 'right' : 'left',
                  color: '#999999' });
    }
  }
  for (let ts of list) {
    const raw = String(ts.content || '');
    ts = withChosenFont(ts, raw);
    const pdeg = pageRotation(pg);
    if (pdeg && !ts.rotate) ts = { ...ts, rotate: (360 - pdeg) % 360 };
    let s = raw;
    for (const k in vals) s = s.split('{' + k + '}').join(vals[k]);
    if (s.trim()) out.push({ ...ts, text: s });
  }
  return out;
}

/* ── 書体 ──
   macOS に入っているものを前提に並べている。実在を確認済み（2026-09）。
   どの書体にも末尾に日本語フォントを積むので、欧文書体を選んでも和文は出る。
   s:'m' は和文フォールバックを明朝に、'g' はゴシックにする。 */
const JP_M = '"Hiragino Mincho ProN","YuMincho","Yu Mincho","Noto Serif JP",serif';
const JP_G = '"Hiragino Sans","YuGothic","Yu Gothic","Noto Sans JP",sans-serif';

const FONTS = [
  // 和文・明朝
  { g: '和文・明朝', k: 'mincho',      n: 'ヒラギノ明朝',       f: '"Hiragino Mincho ProN"', s: 'm' },
  { g: '和文・明朝', k: 'mincho-yu',   n: '游明朝',             f: '"YuMincho","Yu Mincho"', s: 'm' },
  { g: '和文・明朝', k: 'bunkyu',      n: '凸版文久明朝',       f: '"Toppan Bunkyu Mincho"', s: 'm' },
  { g: '和文・明朝', k: 'midashi',     n: '凸版文久見出明朝',   f: '"Toppan Bunkyu Midashi Mincho"', s: 'm' },
  // 和文・ゴシック
  { g: '和文・ゴシック', k: 'gothic',     n: 'ヒラギノ角ゴ',     f: '"Hiragino Sans"', s: 'g' },
  { g: '和文・ゴシック', k: 'gothic-yu',  n: '游ゴシック',       f: '"YuGothic","Yu Gothic"', s: 'g' },
  { g: '和文・ゴシック', k: 'bunkyu-g',   n: '凸版文久ゴシック', f: '"Toppan Bunkyu Gothic"', s: 'g' },
  { g: '和文・ゴシック', k: 'maru',       n: 'ヒラギノ丸ゴ',     f: '"Hiragino Maru Gothic ProN"', s: 'g' },
  { g: '和文・ゴシック', k: 'tsukushi',   n: '筑紫A丸ゴシック',  f: '"Tsukushi A Round Gothic"', s: 'g' },
  // 和文・その他
  { g: '和文・その他', k: 'kaisho',    n: 'Klee（楷書）',       f: '"Klee","Klee One"', s: 'm' },
  { g: '和文・その他', k: 'kyokasho',  n: '游教科書体',         f: '"YuKyokasho"', s: 'm' },
  // 欧文・サンセリフ
  { g: '欧文・サンセリフ', k: 'sans',        n: 'Helvetica Neue',            f: '"Helvetica Neue",Arial', s: 'g' },
  { g: '欧文・サンセリフ', k: 'futura',      n: 'Futura',                    f: 'Futura', s: 'g' },
  { g: '欧文・サンセリフ', k: 'futura-cond', n: 'Avenir Next Condensed（縦長）', f: '"Avenir Next Condensed"', s: 'g' },
  { g: '欧文・サンセリフ', k: 'avenir',      n: 'Avenir Next',               f: '"Avenir Next",Avenir', s: 'g' },
  { g: '欧文・サンセリフ', k: 'optima',      n: 'Optima',                    f: 'Optima', s: 'g' },
  { g: '欧文・サンセリフ', k: 'gill',        n: 'Gill Sans',                 f: '"Gill Sans"', s: 'g' },
  { g: '欧文・サンセリフ', k: 'impact',      n: 'Impact（極太）',            f: 'Impact', s: 'g' },
  // 欧文・セリフ
  { g: '欧文・セリフ', k: 'serif',       n: 'Georgia',             f: 'Georgia,"Times New Roman"', s: 'm' },
  { g: '欧文・セリフ', k: 'didot',       n: 'Didot',               f: 'Didot', s: 'm' },
  { g: '欧文・セリフ', k: 'bodoni',      n: 'Bodoni 72',           f: '"Bodoni 72"', s: 'm' },
  { g: '欧文・セリフ', k: 'baskerville', n: 'Baskerville',         f: 'Baskerville', s: 'm' },
  { g: '欧文・セリフ', k: 'hoefler',     n: 'Hoefler Text',        f: '"Hoefler Text"', s: 'm' },
  { g: '欧文・セリフ', k: 'copperplate', n: 'Copperplate',         f: 'Copperplate', s: 'm' },
  // 欧文・その他
  { g: '欧文・その他', k: 'american', n: 'American Typewriter',  f: '"American Typewriter"', s: 'm' },
  { g: '欧文・その他', k: 'rockwell', n: 'Rockwell',             f: 'Rockwell', s: 'm' },
  { g: '欧文・その他', k: 'mono',     n: 'Menlo（等幅）',        f: 'Menlo,"Courier New"', s: 'g' },
  { g: '欧文・その他', k: 'script',   n: 'Snell Roundhand（筆記体）', f: '"Snell Roundhand"', s: 'm' },
];

const FONT_STACK = Object.fromEntries(
  FONTS.map(x => [x.k, x.f + ',' + (x.s === 'm' ? JP_M : JP_G)]));
const FONT_LABEL = Object.fromEntries(FONTS.map(x => [x.k, x.n]));
const FONT_KEYS = FONTS.map(x => x.k);

/* 本の情報で選んだ書体を、その差し込み文字に当てる。
   版面側が -bold なら太さは保つ。 */
function withChosenFont(ts, content) {
  for (const k of ['title', 'subtitle', 'credit']) {
    if (!content.includes('{' + k + '}')) continue;
    const choice = CFG['font_' + k];
    if (!choice || !FONT_STACK[choice]) return ts;
    const bold = String(ts.font || '').endsWith('-bold');
    return { ...ts, font: choice + (bold ? '-bold' : '') };
  }
  return ts;
}

/** テキストを透過キャンバスに描く（回転込み）。PDFにはPNGとして貼る */
const _measure = document.createElement('canvas').getContext('2d');

function fontSpec(ts, sizePx) {
  const name = String(ts.font || 'sans');
  const bold = name.endsWith('-bold');
  const base = bold ? name.slice(0, -5) : name;
  return `${bold ? '700 ' : ''}${sizePx}px ${FONT_STACK[base] || FONT_STACK.sans}`;
}

/* 折り返し。renderText と行数の事前計算で同じ結果になるよう1箇所にまとめる */
function wrapText(text, font, wPx) {
  _measure.font = font;
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (_measure.measureText(cur + ch).width > wPx && cur) { lines.push(cur); cur = ch; }
      else cur += ch;
    }
    lines.push(cur);
  }
  return lines;
}

/** 描かずに、行数と一番長い行の幅(mm)を知る。帯の長さを決めるのに要る。
    倍率によらない値なので固定倍率で測る。 */
function textExtent(ts, text) {
  const S = 4;
  const font = fontSpec(ts, ts.size * (25.4 / 72) * S);
  const lines = wrapText(text, font, (ts.w || 60) * S);
  _measure.font = font;
  let max = 0;
  for (const l of lines) max = Math.max(max, _measure.measureText(l).width);
  return { lines: lines.length, wMm: max / S };
}
const countLines = (ts, text) => textExtent(ts, text).lines;

function renderText(ts, pxPerMm) {
  const sizePx = ts.size * (25.4 / 72) * pxPerMm;
  const lead = (ts.leading || ts.size * 1.5) * (25.4 / 72) * pxPerMm;
  const wPx = (ts.w || 60) * pxPerMm;
  const font = fontSpec(ts, sizePx);
  const lines = wrapText(ts.text, font, wPx);
  const bw = Math.ceil(wPx) + 4, bh = Math.ceil(lead * (lines.length - 1) + sizePx * 1.45) + 4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, bw); c.height = Math.max(1, bh);
  const x = c.getContext('2d');
  x.font = font; x.fillStyle = ts.color || '#000'; x.textBaseline = 'top';
  lines.forEach((l, i) => {
    const lw = x.measureText(l).width;
    const lx = ts.align === 'right' ? bw - lw : (ts.align === 'center' ? (bw - lw) / 2 : 0);
    x.fillText(l, lx, i * lead);
  });
  const leadMm = (ts.leading || ts.size * 1.5) * (25.4 / 72);
  const deg = norm360(ts.rotate || 0);
  if (!deg) return { canvas: c, wMm: bw / pxPerMm, hMm: bh / pxPerMm,
                     lines: lines.length, leadMm };
  /* テキストの rotate は反時計回りが正（templates.json の rot-one が 90 = 反時計90） */
  const swap = deg === 90 || deg === 270;
  const r = document.createElement('canvas');
  r.width = swap ? c.height : c.width;
  r.height = swap ? c.width : c.height;
  const rx = r.getContext('2d');
  rx.translate(r.width / 2, r.height / 2);
  rx.rotate(-deg * Math.PI / 180);
  rx.drawImage(c, -c.width / 2, -c.height / 2);
  return { canvas: r, wMm: r.width / pxPerMm, hMm: r.height / pxPerMm, rotated: deg,
           lines: lines.length, leadMm };
}

/* ═══════════ プレビュー描画 ═══════════ */

function drawPage(cv, pg, pageNo, pxPerMm) {
  cv.width = Math.round(PW * pxPerMm); cv.height = Math.round(PH * pxPerMm);
  const x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
  const t = T[pg.template];
  if (!t) { x.fillStyle = '#c00'; x.font = `${14 * pxPerMm / 3}px sans-serif`;
            x.fillText('不明な版面: ' + pg.template, 10, 24); return; }
  /* pg.flip（上下逆に刷る指定）は、ここでは効かせない。
     画面には「めくったときに見える向き」を出し、反転はPDFを組むときだけ行う
     （placeOps）。紙の上の向きは印刷の都合であって、確認したいのは仕上がりの姿。 */

  const { dx, dy } = gutterShift(t, pageNo);
  const list = pg.photos || [];

  for (const fr of (t.images || [])) {
    const nm = list[fr.slot || 0];
    const p = nm && photoBy(nm);
    if (!p) continue;
    const src = preparedSrc(p, pg, fr);
    const f = fitBox(src.width, src.height, fr.w, fr.h, fr.fit || 'contain',
                     cropOf(pg, fr.slot || 0));
    const ox = (fr.x + dx + (fr.w - f.drawW) / 2) * pxPerMm;
    const oy = (fr.y + dy + (fr.h - f.drawH) / 2) * pxPerMm;
    x.drawImage(src, f.sx, f.sy, f.sw, f.sh, ox, oy, f.drawW * pxPerMm, f.drawH * pxPerMm);
  }
  const band = pageBand(pg, t);
  if (band) {
    x.save();
    x.globalAlpha = band.opacity;
    x.fillStyle = band.color;
    x.fillRect(band.x * pxPerMm, band.y * pxPerMm, band.w * pxPerMm, band.h * pxPerMm);
    x.restore();
  }

  for (const ts of pageTexts(pg, t, pageNo)) {
    const r = renderText(ts, pxPerMm);
    const px = (ts.x + dx) * pxPerMm;
    const py = (textTopMm(ts, r) + dy) * pxPerMm;
    x.drawImage(r.canvas, px, py);
  }
  x.strokeStyle = '#e2e2e0'; x.strokeRect(.5, .5, cv.width - 1, cv.height - 1);
}

/* ═══════════ 切り抜きの調整 ═══════════ */

/** 右ペインのプレビューを、指やマウスでドラッグして切り抜き位置を動かす。
    Pointer Events なのでマウスもタッチも同じ処理で扱える。 */
/** プレビューの canvas は width:100% / max-height / object-fit:contain なので、
    要素の枠と実際に絵がある範囲がずれる。絵の側の位置と倍率を返す。
    ここを枠のまま計算すると、当たり判定もドラッグ量も狂う。 */
function previewRect(cv) {
  const r = cv.getBoundingClientRect();
  const per = Math.min(r.width / PW, r.height / PH);   // contain と同じ収め方
  return { per, left: r.left + (r.width - PW * per) / 2,
                 top:  r.top  + (r.height - PH * per) / 2 };
}

function bindCropDrag(cv, i) {
  const pg = S.pages[i], t = T[pg.template];
  if (!t || !hasCropFrame(pg, t)) { cv.style.touchAction = ''; cv.classList.remove('cropable'); return; }
  cv.style.touchAction = 'none';          // 触った指でページがスクロールしないように
  cv.classList.add('cropable');
  let st = null;

  cv.onpointerdown = e => {
    const { per, left, top } = previewRect(cv);
    const fr = frameAt(pg, t, i + 1, (e.clientX - left) / per, (e.clientY - top) / per);
    if (!fr) return;
    const slot = fr.slot || 0;
    const src = preparedSrc(photoBy(pg.photos[slot]), pg, fr);
    const c = cropOf(pg, slot);
    const sc = Math.max(fr.w / src.width, fr.h / src.height) * Math.max(1, c.z);
    st = { fr, slot, per, sw: src.width, sh: src.height,
           vw: fr.w / sc, vh: fr.h / sc,
           px: e.clientX, py: e.clientY, fx: c.x, fy: c.y, z: c.z, moved: false };
    cv.setPointerCapture(e.pointerId);
  };

  cv.onpointermove = e => {
    if (!st) return;
    const mmx = (e.clientX - st.px) / st.per, mmy = (e.clientY - st.py) / st.per;
    if (!st.moved && Math.abs(mmx) + Math.abs(mmy) < 0.5) return;
    st.moved = true;
    /* 指の動きぶんだけ写真が動くよう、使う範囲を逆向きにずらす */
    const fx = st.fx - (mmx / st.fr.w) * st.vw / st.sw;
    const fy = st.fy - (mmy / st.fr.h) * st.vh / st.sh;
    const hx = st.vw / (2 * st.sw), hy = st.vh / (2 * st.sh);
    setCrop(pg, st.slot, { z: st.z,
      x: Math.max(hx, Math.min(1 - hx, fx)),
      y: Math.max(hy, Math.min(1 - hy, fy)) });
    drawPage(cv, pg, i + 1, 2.6);        // 動かしている間はこの1枚だけ描き直す
  };

  cv.onpointerup = cv.onpointercancel = () => {
    if (!st) return;
    const moved = st.moved;
    st = null;
    if (moved) { renderGrid(); drawPreview(); }
  };
}

function togglePicker(slot) {
  S.picker = (S.picker === slot) ? null : slot;
  renderIns();
}

function choosePhoto(slot, idx) {
  const q = S.photos[idx]; if (!q) return;
  S.picker = null;
  setPhoto(slot, q.name);            // setPhoto の中で renderIns まで走る
}

function rotateSlot(slot, step) {
  const pg = S.pages[S.sel]; if (!pg) return;
  setSlotRot(pg, slot, slotRotation(pg, slot) + step);
  renderIns(); touch(false);
}

function setZoom(slot, pct) {
  const pg = S.pages[S.sel]; if (!pg) return;
  setCrop(pg, slot, { ...cropOf(pg, slot), z: Math.max(1, pct / 100) });
  const l = $(`#zl${slot}`); if (l) l.textContent = `${pct}%`;
  const cv = $('#insPrev'); if (cv) drawPage(cv, pg, S.sel + 1, 2.6);
  clearTimeout(setZoom._t);
  setZoom._t = setTimeout(() => { renderGrid(); drawPreview(); }, 120);
}

function resetCrop(slot) {
  const pg = S.pages[S.sel]; if (!pg) return;
  clearCrop(pg, slot);
  if (pg.rots) { delete pg.rots[slot]; if (!pg.rots.some(v => v != null)) delete pg.rots; }
  renderIns(); touch(false);
}

/* ═══════════ 台割 ═══════════ */

const RHYTHM = {
  simple: ['big', 'one', 'one', 'duo', 'one', 'big', 'one', 'duo'],
  portrait: ['fill', 'one', 'one', 'fill', 'one', 'one'],
};

/** 2枚組の分割の向きを、写真の縦横から選ぶ。
    半分の枠の縦横比に近いほうを採る（切り抜かれる量が少なくて済む）。 */
function duoTemplate(a, b) {
  const half = k => { const f = T[k] && T[k].images[0]; return f ? f.w / f.h : 1; };
  const ar = ((a.w / a.h) + (b.w / b.h)) / 2;
  const near = k => Math.abs(Math.log(ar / half(k)));
  return near('duo-fill-v') <= near('duo-fill-h') ? 'duo-fill-v' : 'duo-fill-h';
}

/** ページいっぱいの1枚。ページと向きの違う写真は90°回して合わせる */
function fillPage(p) {
  const pg = { template: FILL_TPL, photos: [p.name], caption: '' };
  const deg = autoRotFor(p);
  if (deg) pg.rotate = deg;
  return pg;
}

function autoPlan(mode) {
  mode = mode || CFG.plan_mode || 'fill';
  const ph = S.photos;
  if (!ph.length) { toast('先に写真を読み込んでください'); return; }
  const pages = [{ template: CFG.cover_template || 'cover', photos: [ph[0].name] },
                 { template: 'blank' }];
  const q = ph.slice(1);
  /* 裏表紙にも写真を1枚使う。表紙と重ならないよう、最後の1枚を取り分ける
     （枚数が少ないときは表紙と同じ写真を使う） */
  const backName = (ph.length >= 3) ? q.pop().name : ph[0].name;
  if (mode === 'duo') {
    /* 2枚ずつ、隙間なく接する版面に置く。写真が1枚余ったら全面1枚に。
       版面(T)は向きごとに切り替わっているので、縦横どちらでもこの1本で足りる */
    while (q.length) {
      if (q.length >= 2) {
        const a = q.shift(), b = q.shift();
        pages.push({ template: duoTemplate(a, b), photos: [a.name, b.name], caption: '', caption2: '' });
      } else {
        pages.push(fillPage(q.shift()));
      }
    }
  } else if (ORIENT_NAME === 'landscape') {
    /* 横ページ。使える版面が縦とは別なので、ここで分ける */
    const R = { fill: ['fill'], portrait: ['fill', 'one', 'one', 'fill', 'one', 'one'],
                simple: ['fill', 'one', 'one', 'duo', 'one', 'fill', 'one', 'duo'] };
    const rh = R[mode] || R.fill;
    let step = 0;
    while (q.length) {
      const kind = rh[step++ % rh.length];
      if (kind === 'duo' && q.length >= 2) {
        const a = q.shift(), b = q.shift();
        pages.push({ template: 'land-duo', photos: [a.name, b.name], caption: '', caption2: '' });
        continue;
      }
      const p = q.shift();
      if (kind === 'fill') { pages.push(fillPage(p)); continue; }
      /* 余白ありの1枚。縦写真は回さず land-tall に置く */
      pages.push(p.orientation === 'portrait'
        ? { template: 'land-tall', photos: [p.name], caption: '' }
        : { template: 'land-one', photos: [p.name], caption: '' });
    }
  } else if (mode === 'fill') {
    q.forEach(p => pages.push(fillPage(p)));
  } else if (mode === 'portrait') {
    q.forEach((p, i) => {
      const kind = RHYTHM.portrait[i % RHYTHM.portrait.length];
      const tall = p.orientation === 'portrait';
      pages.push({ template: kind === 'fill' ? 'portrait-fill' : 'portrait-one',
                   photos: [p.name],
                   rotate: tall ? undefined : ROT_DEG,
                   caption: '' });
    });
  } else {
    let step = 0;
    while (q.length) {
      const kind = RHYTHM.simple[step++ % RHYTHM.simple.length];
      if (kind === 'duo' && q.length >= 2 &&
          q.slice(0, 2).every(p => p.orientation !== 'portrait')) {
        const a = q.shift(), b = q.shift();
        pages.push({ template: 'landscape-duo', photos: [a.name, b.name], caption: '', caption2: '' });
        continue;
      }
      const p = q.shift();
      const tall = p.orientation === 'portrait';
      const t = kind === 'big' ? (tall ? 'portrait-fill' : 'landscape-wide')
                               : (tall ? 'portrait-one' : 'landscape-one');
      pages.push({ template: t, photos: [p.name], caption: '' });
    }
  }
  /* 横ページ（上とじ）は、表紙と裏表紙が1枚の紙の同じ面にあり、横の折り目で折ると
     裏表紙側の半分が180°回る。あらかじめ上下逆に組んでおくと、閉じた本を裏返したときに
     表紙と天地が揃う。縦ページ（左とじ）は縦の折り目なので、この入れ替えは起きない。 */
  const backTpl = T[CFG.back_cover_template] ? CFG.back_cover_template : 'back-cover';
  const back = { template: backTpl };
  if ((T[backTpl] || {}).slots) back.photos = [backName];
  if (ORIENT_NAME === 'landscape' && CFG.back_cover_flip !== false) back.flip = true;
  pages.push(back);
  while (pages.length % 4) pages.splice(pages.length - 1, 0, { template: 'blank' });
  S.pages = pages; S.sel = -1;
  renderAll();
}

/* ═══════════ 見開きプレビュー ═══════════ */

/** 実際にめくったときの見え方で組にする。
    表紙(1ページ目)と裏表紙(最終ページ)は相手がいないので単独。
    間は 2|3, 4|5 … と組になる（ページ総数が4の倍数なので必ず割り切れる）。 */
function bookSpreads() {
  const n = S.pages.length;
  if (!n) return [];
  if (n === 1) return [[0]];
  const out = [[0]];
  for (let i = 1; i < n - 1; i += 2) out.push([i, i + 1]);
  out.push([n - 1]);
  return out;
}

function openPreview(at) {
  if (!S.pages.length) { toast('先に写真を読み込んでください'); return; }
  S.prev = bookSpreads();
  S.prevAt = 0;
  if (at != null) {                       // 選択中のページを含む見開きから開く
    const k = S.prev.findIndex(sp => sp.includes(at));
    if (k >= 0) S.prevAt = k;
  }
  $('#prev').classList.add('on');
  addEventListener('keydown', previewKeys);
  addEventListener('resize', drawPreview);
  drawPreview();
}

function closePreview() {
  $('#prev').classList.remove('on');
  removeEventListener('keydown', previewKeys);
  removeEventListener('resize', drawPreview);
  $('#prevStage').innerHTML = '';          // 大きなcanvasを持ち続けない
}

function previewKeys(e) {
  if (e.key === 'Escape') { closePreview(); return; }
  /* ページ番号を打っている最中に、矢印やスペースでめくらない */
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); previewGo(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); previewGo(-1); }
  if (e.key === 'Home') previewGo(-1e9);
  if (e.key === 'End') previewGo(1e9);
}

/** 入力欄を、いま表示している見開きの先頭ページに戻す */
function syncJumpInput() {
  const inp = $('#prevPage'), sp = S.prev[S.prevAt];
  if (inp && sp) inp.value = sp[0] + 1;
}

/** ページ番号を入れて、そのページを含む見開きへ飛ぶ。
    範囲外は端に寄せ、空や0のような入力は現在のページに戻す。 */
function previewJump(v) {
  const n = S.pages.length;
  let p = Math.round(+v);
  if (!isFinite(p) || !p) { syncJumpInput(); return; }
  p = Math.max(1, Math.min(n, p));
  const k = S.prev.findIndex(sp => sp.includes(p - 1));
  if (k < 0) { syncJumpInput(); return; }
  S.prevAt = k;
  const inp = $('#prevPage');
  if (inp) inp.value = p;            // 99→20 のように直した番号を見せる
  drawPreview(true);                 // 打った番号は上書きしない
}

function previewGo(d) {
  S.prevAt = Math.max(0, Math.min(S.prev.length - 1, S.prevAt + d));
  drawPreview();
}

function drawPreview(keepInput) {
  if (!$('#prev').classList.contains('on')) return;
  const sp = S.prev[S.prevAt];
  if (!sp) return;

  /* 左頁・右頁の並びは とじ方向 に従う（右開きなら左右が入れ替わる） */
  const items = sp.map(i => ({ i, right: isRightPage(i + 1) }));
  if (items.length === 2) items.sort((a, b) => Number(a.right) - Number(b.right));

  const stage = $('#prevStage');
  const box = stage.parentElement.getBoundingClientRect();
  const availW = box.width - 56, availH = box.height - 56;
  /* 縦ページは左右に並べ、横ページは上下に積む（上とじなので上下にめくる） */
  const vert = ORIENT_NAME === 'landscape';
  const cols = vert ? 1 : items.length, rows = vert ? items.length : 1;
  const scale = Math.max(0.4, Math.min(availW / (cols * PW), availH / (rows * PH)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  stage.className = 'spread' + (items.length === 2 ? ' two' : ' one') + (vert ? ' vert' : '');
  stage.innerHTML = '';
  for (const it of items) {
    const cv = document.createElement('canvas');
    drawPage(cv, S.pages[it.i], it.i + 1, scale * dpr);
    cv.style.width = (PW * scale) + 'px';
    cv.style.height = (PH * scale) + 'px';
    stage.appendChild(cv);
  }

  const nums = items.map(it => it.i + 1);
  const label = sp.length === 1
    ? (sp[0] === 0 ? `表紙（${nums[0]}ページ）` : `裏表紙（${nums[0]}ページ）`)
    : `${nums[0]} – ${nums[1]} ページ`;
  const unit = ORIENT_NAME === 'landscape' ? '面' : '見開き';
  $('#prevPos').textContent = `${label}　／　${unit} ${S.prevAt + 1} / ${S.prev.length}`;
  $('#prevBack').disabled = S.prevAt === 0;
  $('#prevNext').disabled = S.prevAt === S.prev.length - 1;
  const inp = $('#prevPage'), tot = $('#prevTotal');
  if (tot) tot.textContent = S.pages.length;
  if (inp) {
    inp.max = S.pages.length;
    if (!keepInput) inp.value = nums[0];      // ボタンや矢印で動いたときだけ追従させる
  }
}

/* ═══════════ 本の情報（タイトルなど） ═══════════ */

const INFO_KEY = 'photobook.bookinfo';
const INFO_FIELDS = ['title', 'subtitle', 'credit',
                     'font_title', 'font_subtitle', 'font_credit',
                     'cover_pos', 'size_title', 'size_subtitle',
                     'color_title', 'color_subtitle',
                     'band', 'band_color', 'band_opacity'];

/** 今日の日付。サブタイトルの出発点に使う。書き換えれば以降はそれが残る */
function todayText() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function loadBookInfo() {
  let j = null;
  try {
    j = JSON.parse(localStorage.getItem(INFO_KEY) || 'null');
    /* 数値や真偽値も入るので、型で弾かない（以前は文字列だけ拾っていて
       文字サイズが保存されていなかった） */
    if (j) for (const k of INFO_FIELDS) if (j[k] !== undefined && j[k] !== null) CFG[k] = j[k];
  } catch (e) { /* file:// やプライベートウィンドウでは使えないことがある */ }
  /* まだ一度も触っていなければ、今日の日付を入れておく。
     何か1つでも編集すれば全項目が保存され、そこで日付は固定される。 */
  if (CFG.subtitle_today !== false && (!j || j.subtitle === undefined)) {
    CFG.subtitle = todayText();
  }
}

function saveBookInfo() {
  try {
    /* ?? にすること。|| だと false や 0 が空文字になって型が壊れる */
    localStorage.setItem(INFO_KEY,
      JSON.stringify(Object.fromEntries(INFO_FIELDS.map(k => [k, CFG[k] ?? '']))));
  } catch (e) { /* 保存できなくても動作は続ける */ }
}

/** 絵だけ描き直す。右ペインの中身は作り直さない */
function redrawPages() {
  renderGrid();
  const p = $('#insPrev');
  if (p && S.sel >= 0) drawPage(p, S.pages[S.sel], S.sel + 1, 2.6);
  drawPreview();
}

/* mode:
     'now'     … すぐ描き直す。右ペインはそのまま（書体・大きさなど、
                  操作した部品自身が新しい値を持っているもの）
     'rebuild' … 右ペインを作り直す（帯のON/OFFのように、出る部品が変わるとき）
     未指定    … 文字入力用。少し待ってから描き直す
   右ペインを作り直すと、開いていたアコーディオンが閉じて操作が続けられなくなるので、
   作り直しは本当に必要なときだけにする。 */
function setBookInfo(k, v, mode) {
  CFG[k] = v;
  saveBookInfo();
  clearTimeout(setBookInfo._t);
  if (mode === 'now') { redrawPages(); return; }
  if (mode === 'rebuild') { rebuildBookInfo(); redrawPages(); return; }
  setBookInfo._t = setTimeout(redrawPages, 250);
}

/** 帯の濃さ。ラベルだけその場で書き換え、絵は少し間引いて描き直す */
function setOpacity(v) {
  CFG.band_opacity = +v;
  saveBookInfo();
  const l = $('#opLabel');
  if (l) l.textContent = `濃さ ${v}%`;
  clearTimeout(setOpacity._t);
  setOpacity._t = setTimeout(redrawPages, 100);
}

/** "fff" や "FFFFFF" も受け取り、#ffffff の形にそろえる。途中入力なら null */
function normHex(v) {
  let x = String(v == null ? '' : v).trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(x)) x = x.split('').map(c => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(x) ? '#' + x.toLowerCase() : null;
}

/** 色を決める。パレットとコード欄の両方を持っているので、
    入力元でない側だけを書き換える（renderIns を呼ぶと入力中にフォーカスが飛ぶ）。 */
function setColor(field, v, src) {
  const hex = normHex(v);
  if (!hex) return;
  CFG[field] = hex;
  saveBookInfo();
  const sw = $('#sw_' + field), tx = $('#hex_' + field);
  if (sw && src !== 'sw') sw.value = hex;
  if (tx && src !== 'tx') tx.value = hex;
  clearTimeout(setColor._t);
  setColor._t = setTimeout(() => {
    renderGrid();
    const p = $('#insPrev'); if (p && S.sel >= 0) drawPage(p, S.pages[S.sel], S.sel + 1, 2.6);
    drawPreview();
  }, 150);
}

/* 画面のどこからでも色を吸える（写真からも）。Chrome/Edge の EyeDropper API。 */
async function pickColor(field) {
  if (!window.EyeDropper) { toast('このブラウザはスポイトに対応していません'); return; }
  try {
    const { sRGBHex } = await new EyeDropper().open();
    setColor(field, sRGBHex);
  } catch (e) { /* Escでキャンセルされただけ */ }
}

/** いま実際に使われている色（未設定なら版面の既定）を返す */
function effColor(field) {
  if (CFG['color_' + field]) return CFG['color_' + field];
  const t = T[CFG.cover_template || 'cover'] || {};
  const x = (t.texts || []).find(v => String(v.content).includes('{' + field + '}'));
  return (x && x.color) || '#ffffff';
}

/** いま実際に使われている文字サイズ（未設定なら版面の既定） */
function effSize(field) {
  if (+CFG['size_' + field]) return +CFG['size_' + field];
  const t = T[CFG.cover_template || 'cover'] || {};
  const x = (t.texts || []).find(v => String(v.content).includes('{' + field + '}'));
  return x ? Math.round(x.size * 10) / 10 : 12;
}

function fontSelect(field) {
  const cur = CFG['font_' + field];
  let html = '', group = '';
  for (const x of FONTS) {
    if (x.g !== group) { if (group) html += '</optgroup>'; html += `<optgroup label="${x.g}">`; group = x.g; }
    html += `<option value="${x.k}" ${x.k === cur ? 'selected' : ''}
      style="font-family:${x.f.replace(/"/g, "'")}">${x.n}</option>`;
  }
  return `<select onchange="setBookInfo('font_${field}',this.value,'now')" class="fontSel">${html}</optgroup></select>`;
}

function styleRow(field) {
  /* 右ペインが狭いので、書体＋大きさ / 色 の2行に分ける */
  return `<div class="styleRow">
      ${fontSelect(field)}
      <input type="number" class="sz" min="6" max="120" step="0.5" title="文字の大きさ（pt）。空にすると版面の既定"
        value="${effSize(field)}" oninput="setBookInfo('size_${field}',+this.value,'now')"><span class="u">pt</span>
    </div>
    <div class="styleRow">
      <input type="color" id="sw_color_${field}" value="${effColor(field)}" title="カラーパレット"
        oninput="setColor('color_${field}',this.value,'sw')">
      <input type="text" class="hex" id="hex_color_${field}" value="${effColor(field)}"
        spellcheck="false" maxlength="7" title="カラーコード。#なしや3桁でも受け付けます"
        oninput="setColor('color_${field}',this.value,'tx')">
      <button class="tiny" onclick="pickColor('color_${field}')"
        title="画面から色を吸う（写真からも）">スポイト</button>
    </div>`;
}

function bandPicker() {
  const on = !!CFG.band;
  return `<div class="field"><label>帯（座布団）</label>
    <label class="toggle"><input type="checkbox" ${on ? 'checked' : ''}
      onchange="setBookInfo('band',this.checked,'rebuild')"><span>文字の下に帯を敷く</span></label>
    ${on ? `<div class="styleRow">
      <input type="color" id="sw_band_color" value="${CFG.band_color || '#000000'}" title="帯の色"
        oninput="setColor('band_color',this.value,'sw')">
      <input type="text" class="hex" id="hex_band_color" value="${CFG.band_color || '#000000'}"
        spellcheck="false" maxlength="7" oninput="setColor('band_color',this.value,'tx')">
      <button class="tiny" onclick="pickColor('band_color')" title="画面から色を吸う">スポイト</button>
    </div>
    <div class="styleRow">
      <input type="range" min="0" max="100" step="5" class="op"
        value="${CFG.band_opacity == null ? 70 : CFG.band_opacity}"
        oninput="setOpacity(this.value)">
      <span class="u" id="opLabel">濃さ ${CFG.band_opacity == null ? 70 : CFG.band_opacity}%</span>
    </div>
    <p class="hint">選んだ隅のページ端から伸びて、文字を包みます。</p>` : ''}
  </div>`;
}

function posPicker() {
  return `<div class="field"><label>表紙の文字の位置</label>
    <div class="posGrid">
      ${['tl','tr','bl','br'].map(k => `<button class="${CFG.cover_pos === k ? 'on' : ''}"
        onclick="setBookInfo('cover_pos','${k}','rebuild')">${COVER_POS[k]}</button>`).join('')}
    </div></div>`;
}

function openBookInfo() {
  rebuildBookInfo(true);
  $('#bookModal').classList.add('on');
  addEventListener('keydown', bookKeys);
}

function closeBookInfo() {
  $('#bookModal').classList.remove('on');
  removeEventListener('keydown', bookKeys);
}

function bookKeys(e) { if (e.key === 'Escape') closeBookInfo(); }

/** ダイアログの中身を作り直す。開いていないときは何もしない */
function rebuildBookInfo(force) {
  const b = $('#bookBody');
  if (!b) return;
  if (!force && !$('#bookModal').classList.contains('on')) return;
  const top = b.scrollTop;
  b.innerHTML = bookInfoFields();
  b.scrollTop = top;
}

function bookInfoFields() {
  const row = (field, label, ph, val, multi, style) => `
    <div class="field"><label>${label}</label>
      ${multi
        ? `<textarea rows="2" placeholder="${ph}"
             oninput="setBookInfo('${field}',this.value)">${esc(val || '')}</textarea>`
        : `<input type="text" value="${esc(val || '')}" placeholder="${ph}"
             oninput="setBookInfo('${field}',this.value)">`}
      ${style ? styleRow(field) : fontSelect(field)}</div>`;
  return row('title', 'タイトル', '写真集タイトル\n（改行できます）', CFG.title, true, true)
    + row('subtitle', 'サブタイトル', todayText(), CFG.subtitle, false, true)
    + posPicker()
    + bandPicker()
    + row('credit', 'クレジット', 'photo by …', CFG.credit)
    + `<p class="hint">表紙の <code>{title}</code> <code>{subtitle}</code>、
        裏表紙の <code>{credit}</code> に入ります。書体は
        <b>明朝体・ゴシック体</b>が日本語向け、<b>セリフ体・サンセリフ体</b>が欧文向けです
        （欧文を選んでも日本語は表示されます）。
        タイトルは<b>改行できます</b>。長いときは枠幅で自動的にも折り返します。
        タイトルとサブタイトルはひと組で四隅に置けます。色は<b>スポイト</b>で
        写真から吸えます（Chrome / Edge）。
        この設定はブラウザに保存され、次に開いたときも残ります。</p>`;
}

/* ═══════════ 選択モード ═══════════ */

/* 台割 ---------------------------------------------------------------- */
function togglePickPages() {
  S.pickPages = !S.pickPages;
  S.markedPages.clear(); S.lastMark = null;
  if (S.pickPages) S.sel = -1;
  renderAll();
}

function markPage(i, range) {
  if (range && S.lastMark != null) {
    const [a, b] = [Math.min(S.lastMark, i), Math.max(S.lastMark, i)];
    for (let k = a; k <= b; k++) S.markedPages.add(k);
  } else {
    S.markedPages.has(i) ? S.markedPages.delete(i) : S.markedPages.add(i);
    S.lastMark = i;
  }
  renderGrid(); renderIns(); renderCount();
}

function markAllPages() {
  S.pages.forEach((_, i) => S.markedPages.add(i));
  renderGrid(); renderIns();
}

function clearMarkedPages() {
  S.markedPages.clear(); S.lastMark = null;
  renderGrid(); renderIns();
}

/* 一括操作を1回やったら選択モードを抜ける。
   選択が空のままモードだけ残ると、何もできない状態に見えるため。 */
function delMarkedPages() {
  const k = S.markedPages.size; if (!k) return;
  S.pages = S.pages.filter((_, i) => !S.markedPages.has(i));
  S.markedPages.clear(); S.lastMark = null; S.sel = -1;
  S.pickPages = false;
  renderAll();
  toast(`${k}ページを削除しました`);
}

function dupMarkedPages() {
  const idx = [...S.markedPages].sort((a, b) => b - a);   // 後ろから入れると添字がずれない
  if (!idx.length) return;
  for (const i of idx) S.pages.splice(i + 1, 0, JSON.parse(JSON.stringify(S.pages[i])));
  S.markedPages.clear(); S.lastMark = null;
  S.pickPages = false;
  renderAll();
  toast(`${idx.length}ページを複製しました`);
}

/* 写真トレイ ---------------------------------------------------------- */
function togglePickPhotos() {
  S.pickPhotos = !S.pickPhotos;
  S.markedPhotos.clear();
  renderTray();
}

function markPhoto(name) {
  S.markedPhotos.has(name) ? S.markedPhotos.delete(name) : S.markedPhotos.add(name);
  renderTray();
}

function markAllPhotos() {
  S.photos.forEach(p => S.markedPhotos.add(p.name));
  renderTray();
}

function delMarkedPhotos() {
  const names = new Set(S.markedPhotos);
  if (!names.size) return;
  /* 使われているページは版面を残したまま写真の参照だけ外す（枠の位置はずらさない） */
  let used = 0;
  for (const pg of S.pages) {
    if (!pg.photos) continue;
    if (pg.photos.some(n => names.has(n))) used++;
    pg.photos = pg.photos.map(n => (names.has(n) ? '' : n));
  }
  S.photos = S.photos.filter(p => !names.has(p.name));
  S.markedPhotos.clear();
  S.pickPhotos = false;
  renderAll();
  toast(used ? `${names.size}枚を削除（${used}ページの写真が空きました）`
             : `${names.size}枚を削除しました`);
}

/* ═══════════ 狭い画面のタブ ═══════════ */

/* 「狭い画面か」は CSS の @media 一箇所で決める。
   JS 側に px を二重で持つとブレークポイントを直したときに片方だけ取り残される。
   タブバーが出ているかどうかで判定する。 */
const NARROW = () => { const b = $('#tabbar'); return !!b && getComputedStyle(b).display !== 'none'; };

function setTab(name) {
  document.body.dataset.tab = name;
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
}

/* ═══════════ 画面 ═══════════ */

function renderAll() { renderTray(); renderGrid(); renderIns(); renderCount(); }

function renderCount() {
  const n = S.pages.length, r = n % 4, need = r ? 4 - r : 0;
  const el = $('#count'), pad = $('#padBtn'), btn = $('#buildBtn');
  const pv = $('#prevBtn');
  if (pv) pv.disabled = !n;
  const pick = $('#pickBtn');
  if (pick) {
    pick.textContent = S.pickPages ? '完了' : '選択';
    pick.classList.toggle('on', S.pickPages);
    pick.disabled = !n;
  }
  if (!n) { el.textContent = '0ページ'; el.className = 'bad'; pad.style.display = 'none';
            btn.disabled = true; return; }
  if (need) {
    el.textContent = `${n}ページ・あと${need}ページで4の倍数`;
    el.className = 'bad';
    pad.textContent = `白ページを${need}枚足す`; pad.style.display = '';
    btn.disabled = true;
  } else {
    el.textContent = `${n}ページ・${BOOK[BOOK_NAME].paper}×${n / 4}枚`;
    el.title = `${BOOK_NAME}${ORIENT[ORIENT_NAME].label} ／ 店頭で ${ORIENT[ORIENT_NAME].toji(CFG.binding)}`;
    el.className = ''; pad.style.display = 'none'; btn.disabled = false;
  }
}

function padBlanks() {
  const r = S.pages.length % 4; if (!r) return;
  const at = Math.max(0, S.pages.length - 1);
  for (let i = 0; i < 4 - r; i++) S.pages.splice(at, 0, { template: 'blank' });
  renderGrid(); renderCount();
}

function renderTray() {
  const tray = $('#tray');
  tray.innerHTML = S.photos.map((p, i) => `
    <figure class="${S.markedPhotos.has(p.name) ? 'mark' : ''}" data-i="${i}" title="${esc(p.name)}">
      <img src="${p.thumb}" alt="">
      <span class="o">${p.orientation === 'portrait' ? '縦' : '横'}</span>
      ${S.pickPhotos ? '<span class="chk"></span>' : ''}
    </figure>`).join('');
  [...tray.children].forEach(el => {
    const name = S.photos[+el.dataset.i].name;
    el.onclick = () => {
      if (S.pickPhotos) return markPhoto(name);
      addPage(name);
    };
    el.draggable = !S.pickPhotos;
    el.ondragstart = e => {
      if (S.pickPhotos) { e.preventDefault(); return; }
      DRAG.kind = 'photo'; DRAG.photo = name;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', name);
      el.classList.add('drag');
    };
    el.ondragend = () => { el.classList.remove('drag'); endDrag(); };
  });
  $('#trayEmpty').style.display = S.photos.length ? 'none' : '';

  const btn = $('#pickPhotosBtn');
  if (btn) {
    btn.textContent = S.pickPhotos ? '完了' : '選択';
    btn.classList.toggle('on', S.pickPhotos);
    btn.style.display = S.photos.length ? '' : 'none';
  }
  const bar = $('#photoActions');
  if (!bar) return;
  if (!S.pickPhotos) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const k = S.markedPhotos.size;
  bar.style.display = '';
  bar.innerHTML = `<span class="mini">${k ? `${k}枚を選択中` : 'クリックで選択'}</span>
    <span class="spacer"></span>
    <button onclick="markAllPhotos()">全選択</button>
    <button class="danger" onclick="delMarkedPhotos()" ${k ? '' : 'disabled'}>削除</button>`;
}

function addPage(name) {
  const p = photoBy(name); if (!p) return;
  const at = Math.max(0, S.pages.length - 1);
  S.pages.splice(at, 0, fillPage(p));      // 既定と同じ「ページいっぱい」
  S.sel = at; renderGrid(); renderIns(); renderCount();
  if (NARROW()) setTab('grid');
}

/* ドラッグ中の状態。dataTransfer は dragover の最中に読めないので自前で持つ。
   kind: 'page'=台割の並べ替え / 'photo'=トレイからページへ写真を落とす */
const DRAG = { kind: null, from: -1, to: -1, photo: null };

function clearDropMarks() {
  $$('.card.dropL, .card.dropR, .card.dropOn')
    .forEach(el => el.classList.remove('dropL', 'dropR', 'dropOn'));
}

function endDrag() { DRAG.kind = null; DRAG.from = -1; DRAG.to = -1; DRAG.photo = null; clearDropMarks(); }

/** トレイから落とされた写真をページへ入れる。
    空きスロットがあればそこへ、無ければ1枚目を差し替える。
    写真を置けない版面（白ページ・裏表紙など）は、縦いっぱいの版面に変える。 */
function assignPhotoToPage(i, name, slot) {
  const pg = S.pages[i], p = photoBy(name);
  if (!pg || !p) return;
  const slots = (T[pg.template] || {}).slots || 0;
  if (!slots) {
    Object.assign(pg, fillPage(p));
    toast(`${i + 1}ページ目を「縦・ページいっぱい」にして写真を入れました`);
  } else {
    pg.photos = pg.photos || [];
    while (pg.photos.length < slots) pg.photos.push('');
    let at = (slot != null && slot >= 0 && slot < slots) ? slot : pg.photos.findIndex(n => !n);
    if (at < 0) at = 0;
    pg.photos[at] = name;
    clearCrop(pg, at);                  // 別の写真なので切り抜きは引き継がない
    /* 縦いっぱいの版面では「横写真だけ回す」という既定の規則をあてはめ直す。
       前の写真のための回転が残ったままだと、縦写真を入れたときに横倒しになる。 */
    if (slots === 1 && pg.template === FILL_TPL) {
      const deg = autoRotFor(p);
      if (deg) pg.rotate = deg; else delete pg.rotate;
    }
    toast(slots > 1 ? `${i + 1}ページ目の${at + 1}枚目に入れました`
                    : `${i + 1}ページ目の写真を差し替えました`);
  }
  S.sel = i;
  renderAll();
}

/** 選択中のページを1つ前／後ろへ動かす。ドラッグの使えないタッチ用 */
function movePageBy(d) {
  const i = S.sel, j = i + d;
  if (i < 0 || j < 0 || j >= S.pages.length) return;
  const [m] = S.pages.splice(i, 1);
  S.pages.splice(j, 0, m);
  S.sel = j;
  S.markedPages.clear(); S.lastMark = null;
  renderAll();
}

/** from のページを「to の手前」へ動かす。to は 0〜n の挿入位置 */
function movePageTo(from, to) {
  if (from < 0 || to < 0) return false;
  if (to === from || to === from + 1) return false;      // 動かしても同じ位置
  const [m] = S.pages.splice(from, 1);
  const at = to > from ? to - 1 : to;                    // 抜いたぶん詰まる
  S.pages.splice(at, 0, m);
  S.sel = at;
  S.markedPages.clear(); S.lastMark = null;              // 添字が変わるので選択は捨てる
  return true;
}

function renderGrid() {
  const g = $('#grid');
  $('#gridEmpty').style.display = S.pages.length ? 'none' : '';
  g.innerHTML = S.pages.map((pg, i) => `
    <div class="card ${i === S.sel && !S.pickPages ? 'sel' : ''} ${S.markedPages.has(i) ? 'mark' : ''}"
         draggable="${!S.pickPages}" data-i="${i}">
      <canvas class="ph"></canvas>
      <span class="side">${ORIENT_NAME === 'landscape'
        ? (isFarPage(i + 1) ? '下' : '上') : (isFarPage(i + 1) ? '右' : '左')}</span>
      ${pageRotation(pg) ? `<span class="rot">${pageRotation(pg)}°</span>` : ''}
      ${S.pickPages ? '<span class="chk"></span>' : ''}
      <div class="meta"><span class="no">${i + 1}</span><span class="tn">${esc(pg.template)}</span></div>
    </div>`).join('');
  [...g.children].forEach((c, i) => {
    drawPage(c.querySelector('canvas'), S.pages[i], i + 1, 1.35);
    c.onclick = e => {
      if (S.pickPages) { markPage(i, e.shiftKey); return; }
      S.sel = i; renderGrid(); renderIns();
      if (NARROW()) setTab('ins');        // 狭い画面では編集面へ移る
    };
    c.ondragstart = e => {
      if (S.pickPages) { e.preventDefault(); return; }
      DRAG.kind = 'page'; DRAG.from = i; DRAG.to = -1;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));   // これがないと開始しないブラウザがある
      c.classList.add('drag');
    };
    c.ondragend = () => { c.classList.remove('drag'); endDrag(); };
    c.ondragover = e => {
      if (DRAG.kind === 'page') {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        /* カードの左半分なら手前、右半分なら後ろに入る */
        const r = c.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        clearDropMarks();
        c.classList.add(after ? 'dropR' : 'dropL');
        DRAG.to = i + (after ? 1 : 0);
      } else if (DRAG.kind === 'photo') {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        clearDropMarks();
        c.classList.add('dropOn');                       // ページ全体を囲んで示す
      }
    };
    c.ondrop = e => {
      if (!DRAG.kind) return;
      e.preventDefault(); e.stopPropagation();      // 写真取り込みの drop まで上げない
      const { kind, from, to, photo } = DRAG;
      endDrag();
      if (kind === 'page') { if (movePageTo(from, to)) renderAll(); }
      else if (kind === 'photo') assignPhotoToPage(i, photo);
    };
  });

  /* カードのない余白に落としたら末尾へ */
  g.ondragover = e => { if (DRAG.kind === 'page' && e.target === g) { e.preventDefault(); clearDropMarks(); } };
  g.ondrop = e => {
    if (DRAG.kind !== 'page' || e.target !== g) return;
    e.preventDefault(); e.stopPropagation();
    const from = DRAG.from;
    endDrag();
    if (movePageTo(from, S.pages.length)) renderAll();
  };
}

/* 作り直しても、アコーディオンの開閉とスクロール位置は保つ */
function renderIns() {
  const el = $('#ins');
  const top = el ? el.scrollTop : 0;
  buildIns();
  if (el) el.scrollTop = top;
}

function buildIns() {
  const el = $('#ins'), i = S.sel;

  if (S.pickPages) {
    const k = S.markedPages.size;
    el.innerHTML = `
      <h2>選択モード</h2>
      <p class="pickState">${k ? `<b>${k}</b> ページを選択中` : 'ページをクリックして選びます'}</p>
      <p class="hint">Shift＋クリックで範囲選択。<br>
        もう一度ヘッダーの「完了」を押すと解除します。</p>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:10px">
        <button onclick="markAllPages()">すべて選択</button>
        <button onclick="clearMarkedPages()" ${k ? '' : 'disabled'}>選択を解除</button>
      </div>
      <h2>選択したページを</h2>
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <button onclick="dupMarkedPages()" ${k ? '' : 'disabled'}>複製</button>
        <button class="danger" onclick="delMarkedPages()" ${k ? '' : 'disabled'}>削除</button>
      </div>`;
    return;
  }

  if (i < 0 || i >= S.pages.length) {
    el.innerHTML = `<div class="empty">ページを選ぶと<br>ここで版面や写真を変えられます</div>
      <div class="row" style="justify-content:center">
        <button onclick="openBookInfo()">本の情報をひらく</button>
      </div>`;
    return;
  }
  const pg = S.pages[i], t = T[pg.template] || { slots: 0 };
  const groups = { '標準': [], '表紙・その他': [], '応用': [] };
  for (const [k, v] of Object.entries(T)) {
    const g = v.label.startsWith('［応用］') ? '応用'
            : (/^[\u2460-\u2473]/.test(v.label) ? '標準' : '表紙・その他');
    groups[g].push(`<option value="${k}" ${k === pg.template ? 'selected' : ''}>${esc(v.label)}</option>`);
  }
  const opts = Object.entries(groups).filter(([, a]) => a.length)
    .map(([g, a]) => `<optgroup label="${g}">${a.join('')}</optgroup>`).join('');
  const slots = [];
  for (let s = 0; s < (t.slots || 0); s++) {
    const cur = (pg.photos || [])[s] || '';
    const p = photoBy(cur);
    const fr = (t.images || []).find(f => (f.slot || 0) === s);
    const cropable = fr && (fr.fit || 'contain') === 'cover' && p;
    const cz = Math.round(cropOf(pg, s).z * 100);
    const deg = slotRotation(pg, s);
    const multi = (t.slots || 0) > 1;
    slots.push(`<div class="slot">
      <img src="${p ? p.thumb : ''}" alt="" class="pick" onclick="togglePicker(${s})"
           title="タップして写真を選ぶ">
      <button class="photoBtn" onclick="togglePicker(${s})">
        ${p ? esc(cur) : '写真を選ぶ'}<span class="cv">▾</span></button>
    </div>
    ${S.picker === s ? `<div class="pickGrid">
        ${S.photos.length
          ? S.photos.map((q, qi) => `<figure class="${q.name === cur ? 'on' : ''}"
              onclick="choosePhoto(${s},${qi})" title="${esc(q.name)}">
              <img src="${q.thumb}" alt=""></figure>`).join('')
          : '<p class="hint">先に写真を読み込んでください</p>'}
      </div>` : ''}
    ${multi ? `<div class="cropRow">
      <button class="tiny rot" onclick="rotateSlot(${s},-90)" title="左に90°回す">↺</button>
      <span class="u zl">${deg}°</span>
      <button class="tiny rot" onclick="rotateSlot(${s},90)" title="右に90°回す">↻</button>
      <span class="spacer"></span>
      <button class="tiny" onclick="resetCrop(${s})" title="切り抜きと回転を戻す">戻す</button>
    </div>` : ''}
    ${cropable ? `<div class="cropRow">
      <span class="u">拡大</span>
      <input type="range" min="100" max="300" step="5" value="${cz}"
        oninput="setZoom(${s},+this.value)" title="拡大率">
      <span class="u zl" id="zl${s}">${cz}%</span>
      ${multi ? '' : `<button class="tiny" onclick="resetCrop(${s})" title="切り抜きと回転を戻す">戻す</button>`}
    </div>` : ''}`);
  }
  el.innerHTML = `
    ${pg.flip ? `<p class="hint">プレビューは<b>めくったときに見える向き</b>で表示しています。
      紙には上下逆に刷られ、本を裏返すと表紙と天地が揃います（横ページの裏表紙）。</p>` : ''}
    <h2>${i + 1}ページ目（${ORIENT_NAME === 'landscape'
        ? (isFarPage(i + 1) ? '下ページ' : '上ページ')
        : (isFarPage(i + 1) ? '右ページ' : '左ページ')}）</h2>
    <canvas id="insPrev"></canvas>
    ${hasCropFrame(pg, t) ? `<p class="hint">プレビューを<b>ドラッグすると切り抜き位置</b>を動かせます。</p>` : ''}
    <div class="field" style="margin-top:12px">
      <label>版面</label><select onchange="setTpl(this.value)">${opts}</select>
    </div>
    ${(t.slots || 0) > 1 ? '' : `
    <h2>回転</h2>
    <div class="rotRow">
      <button onclick="rotatePage(-90)" title="左に90°回す">↺</button>
      <span class="rotVal">${pageRotation(pg)}°</span>
      <button onclick="rotatePage(90)" title="右に90°回す">↻</button>
      <span class="spacer"></span>
      <button class="tiny" onclick="rotateReset()" ${pageRotation(pg) ? '' : 'disabled'}>戻す</button>
    </div>
    <p class="hint">押すたびに90°ずつ回ります。90°と270°のときは、版面も
      縦向きのものへ自動で入れ替えます。</p>`}
    ${(() => {
      const fs = textFieldsOf(t);
      if (!fs.length) return '';
      return `<h2>入れる文字</h2>` + fs.map(k => `
        <label class="toggle">
          <input type="checkbox" ${isHidden(pg, k) ? '' : 'checked'}
                 onchange="setShowText('${k}', this.checked)">
          <span>${TEXT_LABEL[k]}を入れる</span></label>`).join('')
        + `<p class="hint">中身は右ペイン下の「本の情報」で決めます。
             このページだけ外したいときはここで切ります。</p>`;
    })()}
    ${t.slots ? `<h2>写真</h2>${slots.join('')}` : ''}
    ${t.slots ? `<div class="field"><label>キャプション</label>
      <input type="text" value="${esc(pg.caption || '')}" oninput="setCap('caption',this.value)"></div>` : ''}
    ${t.slots > 1 ? `<div class="field"><label>キャプション（2枚目）</label>
      <input type="text" value="${esc(pg.caption2 || '')}" oninput="setCap('caption2',this.value)"></div>` : ''}
    <h2>順番</h2>
    <div class="row" style="gap:6px">
      <button onclick="movePageBy(-1)" ${i === 0 ? 'disabled' : ''}>← 前へ</button>
      <button onclick="movePageBy(1)" ${i === S.pages.length - 1 ? 'disabled' : ''}>後ろへ →</button>
    </div>
    <p class="hint">中央のページはドラッグでも並べ替えられます（PCのみ）。</p>
    <h2>操作</h2>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      <button onclick="openPreview(${i})">この見開きを大きく見る</button>
      <button onclick="dupPage()">複製</button>
      <button onclick="insBlank()">白ページを後ろに</button>
      <button onclick="delPage()">このページを削除</button>
    </div>
`;
  drawPage($('#insPrev'), pg, i + 1, 2.6);
  bindCropDrag($('#insPrev'), i);
}

function touch(all) {
  if (all) { renderGrid(); } else {
    const c = $(`.card[data-i="${S.sel}"] canvas`);
    if (c) drawPage(c, S.pages[S.sel], S.sel + 1, 1.35);
    const m = $(`.card[data-i="${S.sel}"] .tn`); if (m) m.textContent = S.pages[S.sel].template;
    const r = $(`.card[data-i="${S.sel}"] .rot`);
    if (!!pageRotation(S.pages[S.sel]) !== !!r) renderGrid();
  }
  const p = $('#insPrev'); if (p && S.sel >= 0) drawPage(p, S.pages[S.sel], S.sel + 1, 2.6);
  renderCount();
}

function setTpl(v) { S.pages[S.sel].template = v; S.picker = null; renderIns(); touch(false); }

/* このページで {title} などを出すかどうか。切ったものを pg.hide に貯める */
function setShowText(k, show) {
  const pg = S.pages[S.sel]; if (!pg) return;
  const set = new Set(pg.hide || []);
  show ? set.delete(k) : set.add(k);
  if (set.size) pg.hide = [...set]; else delete pg.hide;
  touch(false);                       // チェックボックスは自分で状態を持つので作り直さない
}
/* 90°/270° では紙面に対して写真の縦横が入れ替わるので、版面も対になっている
   縦向きのものへ差し替える。0°/180° では向きが変わらないので元に戻す。 */
function swapTemplateForRotation(pg, toPortrait) {
  if (toPortrait) {
    if (PAIRS[pg.template]) pg.template = PAIRS[pg.template];
  } else {
    const back = Object.entries(PAIRS).find(([, v]) => v === pg.template);
    if (back) pg.template = back[0];
  }
}

function rotatePage(step) {
  const pg = S.pages[S.sel];
  if (!pg) return;
  const cur = pageRotation(pg);
  const next = norm360(cur + step);
  const wasQuarter = cur === 90 || cur === 270;
  const isQuarter = next === 90 || next === 270;
  if (wasQuarter !== isQuarter) swapTemplateForRotation(pg, isQuarter);
  if (next) pg.rotate = next; else delete pg.rotate;
  renderIns(); renderGrid();
}

function rotateReset() {
  const pg = S.pages[S.sel];
  if (pg) rotatePage(-pageRotation(pg));
}
function setPhoto(i, v) {
  const pg = S.pages[S.sel]; pg.photos = pg.photos || [];
  while (pg.photos.length <= i) pg.photos.push('');
  pg.photos[i] = v;
  clearCrop(pg, i);                     // 別の写真なので切り抜きは引き継がない
  renderIns(); touch(false);
}
function setCap(k, v) { S.pages[S.sel][k] = v; clearTimeout(setCap._t);
  setCap._t = setTimeout(() => touch(false), 300); }
function dupPage() { S.pages.splice(S.sel + 1, 0, JSON.parse(JSON.stringify(S.pages[S.sel])));
  S.sel++; renderGrid(); renderIns(); renderCount(); }
function insBlank() { S.pages.splice(S.sel + 1, 0, { template: 'blank' });
  renderGrid(); renderCount(); }
function delPage() { S.pages.splice(S.sel, 1); S.sel = Math.min(S.sel, S.pages.length - 1);
  renderGrid(); renderIns(); renderCount(); }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}
