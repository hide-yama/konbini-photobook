/* PDF書き出し — 組版だけを行う。
   面付け（中綴じの並べ替え）はマルチコピー機の「小冊子プリント」がやってくれるので、
   こちらは仕上がりサイズ・ページ順の1本を出すだけでよい。
   出典: 富士フイルムBIジャパン「小冊子プリント パーフェクトガイド」2026年5月 第2版 */
'use strict';

const { PDFDocument, rgb } = PDFLib;

/* 入稿経路ごとのファイル容量上限（MB）。0 = 無制限
   出典: https://faq.printing.ne.jp/ マルチコピー機でプリントできるファイル容量 */
const ROUTE_LIMIT = { usb: 0, app: 30, netprint: 10 };
const ROUTE_LABEL = { usb: 'USBメモリ・SDカード', app: 'マルチコピーアプリ', netprint: 'ネットプリント' };

/* マルチコピー機が一度に扱えるページ数 */
const MAX_PAGES = 99;

/* 容量に収めるための段階（dpi / JPEG品質）。上限のある経路でだけ使う */
const SHRINK = [[250, 82], [220, 78], [200, 74], [180, 70],
                [160, 66], [144, 62], [132, 58], [120, 55]];

/* ── 1ページ分の描画命令をつくる（画像はここでJPEGに焼く） ── */
async function buildPageOps(pg, pageNo, dpi, quality) {
  const ops = [];
  const t = T[pg.template];
  if (!t) return ops;
  const { dx, dy } = gutterShift(t, pageNo);

  /* 帯は写真の上・文字の下。ラスタにせずベクターの矩形で置く */
  const band = pageBand(pg, t);
  if (band) ops.push({ kind: 'rect', ...band });

  for (const fr of (t.images || [])) {
    const nm = (pg.photos || [])[fr.slot || 0];
    const p = nm && photoBy(nm);
    if (!p) continue;
    const boxW = Math.max(1, Math.round(fr.w / 25.4 * dpi));
    const boxH = Math.max(1, Math.round(fr.h / 25.4 * dpi));
    const need = Math.round(Math.max(boxW, boxH) * ((fr.fit === 'cover' || fr.src_crop) ? 1.9 : 1.15));
    let src = await decodeAt(p, need, need);
    src = applyRotate(src, pg.rotate || fr.rotate);
    src = cropSrc(src, fr.src_crop);
    const f = fitBox(src.width, src.height, fr.w, fr.h, fr.fit || 'contain');
    const outW = Math.max(1, Math.round(f.drawW / 25.4 * dpi));
    const outH = Math.max(1, Math.round(f.drawH / 25.4 * dpi));
    const c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, outW, outH);
    cx.drawImage(src, f.sx, f.sy, f.sw, f.sh, 0, 0, outW, outH);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality / 100));
    ops.push({
      kind: 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()),
      x: fr.x + dx + (fr.w - f.drawW) / 2, y: fr.y + dy + (fr.h - f.drawH) / 2,
      w: f.drawW, h: f.drawH,
    });
  }

  for (const ts of pageTexts(pg, t, pageNo)) {
    const r = renderText(ts, dpi / 25.4);
    const blob = await new Promise(res => r.canvas.toBlob(res, 'image/png'));
    ops.push({
      kind: 'png', bytes: new Uint8Array(await blob.arrayBuffer()),
      x: ts.x + dx,
      y: textTopMm(ts, r) + dy,
      w: r.wMm, h: r.hMm,
    });
  }
  return ops;
}

/* ── 全ページぶんの描画命令。PDFを組む前に総量が分かる ── */
async function renderBook(pages, dpi, q, log) {
  const all = [];
  for (let i = 0; i < pages.length; i++) {
    all.push(await buildPageOps(pages[i], i + 1, dpi, q));
    if (i % 2 === 0 || i === pages.length - 1) {
      log(`  ページ ${i + 1}/${pages.length}  ${pages[i].template}`);
      await new Promise(r => setTimeout(r));
    }
  }
  return all;
}

/* 各ページの画像はPDFに1回ずつしか入らないので、総バイト数が仕上がりの目安になる */
const opsBytes = all => all.reduce((s, ops) =>
  s + ops.reduce((t, o) => t + (o.bytes ? o.bytes.length : 0), 0), 0);

async function embedAll(doc, ops) {
  const out = [];
  for (const op of ops) {
    if (op.kind === 'rect') { out.push(null); continue; }   // 矩形は埋め込み不要
    try { out.push(op.kind === 'png' ? await doc.embedPng(op.bytes) : await doc.embedJpg(op.bytes)); }
    catch (e) { console.warn('埋め込み失敗', e); out.push(null); }
  }
  return out;
}

/* mm・左上原点 → PDFの pt・左下原点 */
const hexRgb = h => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || '#000000'));
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255)
           : rgb(0, 0, 0);
};

function placeOps(page, ops, embeds) {
  ops.forEach((op, i) => {
    if (op.kind === 'rect') {
      page.drawRectangle({ x: op.x * MM, y: (PH - op.y - op.h) * MM,
        width: op.w * MM, height: op.h * MM,
        color: hexRgb(op.color), opacity: op.opacity });
      return;
    }
    const img = embeds[i];
    if (!img) return;
    page.drawImage(img, { x: op.x * MM, y: (PH - op.y - op.h) * MM,
                          width: op.w * MM, height: op.h * MM });
  });
}

/* ── 本体 ── */
async function exportPDF() {
  const n = S.pages.length;
  if (n % 4) { toast('ページ数が4の倍数ではありません'); return; }
  /* 画面には出していない。既定は usb（容量無制限）＝最高品質のまま1本にする。
     ネットプリントで通したいときだけ config.json の delivery を変える。 */
  const route = CFG.delivery || 'usb';
  const limit = ROUTE_LIMIT[route] ?? 0;          // 0 = 無制限
  const title = CFG.title || '写真集';
  const paper = BOOK[BOOK_NAME].paper;            // 店頭で選ぶ用紙
  const toji = ORIENT[ORIENT_NAME].toji(CFG.binding);
  const tojiBtn = CFG.binding === 'right' ? '「右とじ / 下とじ」' : '「左とじ / 上とじ」';
  let dpi = CFG.image_dpi || 300;
  let q = CFG.jpeg_quality || 95;

  openModal();
  const log = m => { const p = $('#log'); p.textContent += m + '\n'; p.scrollTop = p.scrollHeight; };
  $('#dls').innerHTML = ''; $('#log').textContent = '';
  log(limit ? `入稿: ${ROUTE_LABEL[route]}（1ファイル ${limit}MB まで）`
            : `入稿: ${ROUTE_LABEL[route]}（容量の制限なし）`);
  log(`仕上がり: ${BOOK_NAME}${ORIENT[ORIENT_NAME].label} ${n}ページ → 用紙${paper}・小冊子・${toji}`);

  /* 1. 各ページの描画命令。上限のある経路なら収まるまで画質を下げる */
  let allOps = null, step = -1, overflow = false;
  const budget = limit * 1e6 * 0.96;              // PDFの構造ぶんを見込む
  for (;;) {
    log(`\n組版 ${n}ページ / ${dpi}dpi / JPEG品質 ${q}`);
    allOps = await renderBook(S.pages, dpi, q, log);
    if (!limit) break;
    const bytes = opsBytes(allOps);
    log(`  画像の総量 ${(bytes / 1e6).toFixed(1)} MB / 上限 ${limit} MB`);
    if (bytes <= budget) break;
    /* バイト数はほぼ dpi の2乗に比例する。必要な縮小率から一気に段を飛ばす */
    const est = dpi * Math.sqrt(budget / bytes);
    let next = SHRINK.findIndex(([d], i) => i > step && d <= est && d < dpi);
    if (next < 0) next = step + 1;
    if (next >= SHRINK.length) {
      log('  ! これ以上は下げられません。1本のまま書き出します');
      overflow = true; break;
    }
    step = next;
    [dpi, q] = SHRINK[step];
    log(`  → 上限を超えるので ${dpi}dpi / 品質${q} で組み直します`);
  }

  /* 2. 仕上がりサイズ・ページ順の1本。面付けはマルチコピー機がやる */
  log(`\n${BOOK_NAME}（ページ順）を作成`);
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setAuthor(CFG.credit || '');
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([PW * MM, PH * MM]);
    placeOps(page, allOps[i], await embedAll(doc, allOps[i]));
    if (i % 8 === 7) await new Promise(r => setTimeout(r));
  }
  const bytes = await doc.save();
  const whole = bytes.length / 1e6;
  log(`\n${BOOK_NAME} ${n}ページ / ${whole.toFixed(1)} MB / ${dpi}dpi・品質${q}`);

  /* 3. 結果 */
  let note;
  if (overflow) {
    note = `<p class="warn">★ 画質を下げても ${whole.toFixed(1)} MB あり、${ROUTE_LABEL[route]}の上限${limit}MBに収まりませんでした。<br>
      <b>USBメモリ入稿に切り替えれば容量制限なくこのまま使えます。</b></p>`;
  } else {
    note = `<p class="ok">★ 全${n}ページを1本にまとめました（${whole.toFixed(1)} MB ／ ${dpi}dpi・品質${q}）<br>
      面付けはマルチコピー機の<b>小冊子プリント</b>がやります。このまま持って行ってください。</p>`;
  }
  if (n > MAX_PAGES) {
    note += `<p class="warn">※ ${n}ページあります。マルチコピー機は一度に${MAX_PAGES}ページまでです。</p>`;
  }

  const name = `photobook_${BOOK_NAME}_${ORIENT_NAME === 'landscape' ? 'yoko' : 'tate'}.pdf`;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));

  $('#dls').innerHTML = note
    + '<h3>これ1本で1冊ぶん</h3>'
    + `<div class="dl"><span class="n">${esc(name)}
        <em>${BOOK_NAME}${ORIENT[ORIENT_NAME].label}・全${n}ページ・ページ順</em></span>
        <span class="s">${whole.toFixed(1)} MB</span>
        <a href="${url}" download="${esc(name)}">保存</a></div>`
    + `<h3>マルチコピー機での操作</h3>
       <ol class="steps">
         <li>「プリント」→「普通紙プリント」→「メディア」（USBメモリを挿す）</li>
         <li>このファイルを選び「ふつうのプリント」</li>
         <li><b>用紙サイズ → ${paper}</b>（${BOOK_NAME}の冊子にするため2倍の紙を使います）</li>
         <li><b>小冊子 → ${tojiBtn}</b>（この向きなら<b>${toji}</b>になります）</li>
         <li><b>ちょっと小さめ → する</b>（端が切れるのを防ぎます）</li>
         <li>プリント後、真ん中で二つ折りしてホチキス留め${
             ORIENT_NAME === 'landscape' ? '（折り目が上＝上に向かってめくります）' : ''}</li>
       </ol>
       <p class="hint">「両面」や「2枚を1枚」は<b>選ばないでください</b>。小冊子プリントが
        両面と面付けをまとめて行います。マルチコピー機にホチキス機能はないので、
        綴じるのは手作業です。</p>`;
  log('\n完了');
}

function openModal() { $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); }
