'use strict';

// ---------------------------------------------------------------- utilità

const $ = (s) => document.querySelector(s);
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const fmtEuro = (n) => euro.format(n || 0);
const fmtNum = (n) => (n === null || n === undefined || n === '') ? '' : String(Math.round(n * 1000) / 1000).replace('.', ',');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const oggiIso = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const nuovoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const numIt = (s) => { const n = parseFloat(String(s ?? '').replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const fmtData = (iso) => iso ? iso.split('-').reverse().join('/') : '';

// Ricerca a più parole: tiene solo le voci che contengono TUTTE le parole (come la sidebar del foglio)
function cerca(lista, query, testo, max = 40) {
  const parole = norm(query).trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const v of lista) {
    const t = norm(testo(v));
    if (parole.every((p) => t.includes(p))) {
      out.push(v);
      if (out.length >= max) break;
    }
  }
  return out;
}

let timerAvviso;
function avviso(testo, errore = false) {
  const el = $('#avviso');
  el.textContent = testo;
  el.className = 'avviso' + (errore ? ' errore' : '');
  el.hidden = false;
  clearTimeout(timerAvviso);
  timerAvviso = setTimeout(() => { el.hidden = true; }, errore ? 6000 : 2500);
}

// ---------------------------------------------------------------- archivio locale (IndexedDB)

const DB = (() => {
  let aperto;
  function apri() {
    if (!aperto) {
      aperto = new Promise((res, rej) => {
        const r = indexedDB.open('ordini-app', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('kv');
          r.result.createObjectStore('ordini', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return aperto;
  }
  async function tx(store, modo, fn) {
    const db = await apri();
    return new Promise((res, rej) => {
      const t = db.transaction(store, modo);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
    ordini: () => tx('ordini', 'readonly', (s) => s.getAll()),
    salvaOrdine: (o) => tx('ordini', 'readwrite', (s) => s.put(o)),
    eliminaOrdine: (id) => tx('ordini', 'readwrite', (s) => s.delete(id)),
  };
})();

// ---------------------------------------------------------------- stato

const S = {
  imp: { url: '', token: '' },
  dati: null,
  ordine: null,
  sincronizzando: false,
  storico: null,      // ordini passati dal file Ordini Dati (sezioni Clienti e Vendite)
  rigaAperta: -1,     // riga con il pannello nota/sconto aperto
  clienteScelto: '',  // cliente aperto nella sezione Clienti
};

function nuovoOrdine() {
  return {
    id: nuovoId(),
    data: oggiIso(),
    cliente: '',
    azienda: '',
    pagamento: '',
    consegna: 'Pronta Consegna',
    note: '',
    scontoExtra: '',
    righe: [],
    bozze: { azienda: true, cliente: false },
  };
}

let timerBozza;
function salvaBozza() {
  clearTimeout(timerBozza);
  timerBozza = setTimeout(() => DB.set('bozza', S.ordine), 300);
}

const trovaAzienda = (nome) => S.dati?.aziende.find((a) => a.nome === nome) || null;
const trovaCliente = (nome) => S.dati?.clienti.find((c) => c.nome === nome) || null;
const listino = () => (S.dati?.listini[S.ordine.azienda] || []);

// ---------------------------------------------------------------- calcoli (stesse regole del foglio ordine)

function calcolaRiga(r) {
  const imb = r.imballo || 0;
  if (r.unita === 'ct') {
    return { ct: r.qta, pz: r.qta * imb, totale: r.qta * (imb || 1) * (r.prezzo || 0) };
  }
  return { pz: r.qta, ct: imb ? r.qta / imb : 0, totale: r.qta * (r.prezzo || 0) };
}

function calcolaTotali(o) {
  const az = trovaAzienda(o.azienda);
  let somma = 0, totPz = 0, totCt = 0;
  for (const r of o.righe) {
    const c = calcolaRiga(r);
    somma += c.totale; totPz += c.pz; totCt += c.ct;
  }

  let spedizione = 0, portoTipo = '', portoTesto = '', mancante = '';
  if (az && az.portoFranco && o.righe.length) {
    const pf = az.portoFranco;
    portoTipo = pf.tipo;
    const fatto = pf.tipo === 'eur' ? somma : pf.tipo === 'ct' ? totCt : totPz;
    const raggiunto = fatto >= pf.valore - 1e-9;
    spedizione = raggiunto ? 0 : (az.spedizione || 0);
    portoTesto = pf.tipo === 'eur' ? fmtEuro(pf.valore) : pf.valore + ' ' + pf.tipo;
    if (!raggiunto) mancante = pf.tipo === 'eur' ? fmtEuro(pf.valore - fatto) : fmtNum(Math.ceil((pf.valore - fatto) * 1000) / 1000) + ' ' + pf.tipo;
  }
  const dopoSped = somma + spedizione;

  let scontoPag = 0, scontoPagTesto = '';
  const pag = S.dati?.pagamenti.find((p) => p.nome === o.pagamento);
  if (az && pag && pag.colonna > 0) {
    const v = az.sconti[pag.colonna - 1];
    if (typeof v === 'number') scontoPag = v;
    else if (v) scontoPagTesto = v;
  }
  const dopoPag = dopoSped * (1 + scontoPag);

  const extra = -Math.abs(numIt(o.scontoExtra)) / 100;
  const totale = dopoPag * (1 + extra);

  return { somma, totPz, totCt, spedizione, portoTipo, portoTesto, mancante, scontoPag, scontoPagTesto, extra, totale };
}

const pct = (v) => (v * 100).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + '%';

// ---------------------------------------------------------------- disegno vista "Nuovo"

const CONSEGNA_PRONTA = 'Pronta Consegna';

function mostraConsegna() {
  const testo = S.ordine.consegna || CONSEGNA_PRONTA;
  $('#consegna').value = testo;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(testo);
  $('#consegna-data').value = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  $('#consegna-pronta').hidden = !m;
}

function disegnaOrdine() {
  const o = S.ordine;
  $('#cliente-input').value = o.cliente;
  $('#azienda-input').value = o.azienda;
  $('#data').value = o.data;
  mostraConsegna();
  $('#note').value = o.note;
  $('#sconto-extra').value = o.scontoExtra;
  $('#bozza-azienda').checked = !!o.bozze.azienda;
  $('#bozza-cliente').checked = !!o.bozze.cliente;
  $('#in-modifica').hidden = !o.salvato;
  disegnaPagamenti();
  disegnaInfoCliente();
  disegnaInfoAzienda();
  disegnaRighe();
  disegnaAvvisoEmail();
}

// Bozze richieste ma senza indirizzo: la bozza si crea lo stesso, senza destinatario
function mancanzeEmail(o) {
  const out = [];
  const az = trovaAzienda(o.azienda);
  if (o.bozze?.azienda && az && !az.mail) out.push(`${o.azienda} non ha l'email: la bozza all'azienda sarà senza destinatario`);
  const c = trovaCliente(o.cliente);
  if (o.bozze?.cliente && o.cliente && !(c && c.mail)) out.push(`${o.cliente} non ha l'email: la bozza al cliente sarà senza destinatario`);
  return out;
}

function disegnaAvvisoEmail() {
  $('#avviso-email').innerHTML = mancanzeEmail(S.ordine).map((t) => `<span class="nota">⚠ ${esc(t)}</span>`).join('');
}

function disegnaPagamenti() {
  const sel = $('#pagamento');
  const nomi = (S.dati?.pagamenti || []).map((p) => p.nome).filter((n) => !/^seleziona/i.test(n));
  if (S.ordine.pagamento && !nomi.includes(S.ordine.pagamento)) nomi.unshift(S.ordine.pagamento);
  sel.innerHTML = '<option value="">— scegli —</option>' + nomi.map((n) => `<option>${esc(n)}</option>`).join('');
  sel.value = S.ordine.pagamento;
}

function mostraRipeti() {
  $('#btn-ripeti').hidden = !(S.ordine.cliente && trovaAzienda(S.ordine.azienda));
}

function disegnaInfoCliente() {
  mostraRipeti();
  const el = $('#cliente-info');
  const nome = S.ordine.cliente;
  if (!nome) { el.innerHTML = ''; return; }
  const c = trovaCliente(nome);
  if (!c) { el.innerHTML = '<span class="nota">Cliente non in anagrafica: il PDF avrà solo il nome. Usa "+ Nuovo cliente" per aggiungerlo</span>'; return; }
  const luogo = [c.indirizzo, [c.cap, c.citta, c.prov && `(${c.prov})`].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const contatti = [c.referente, c.tel || c.cell, c.mail].filter(Boolean).join(' · ');
  el.innerHTML = [luogo, contatti].filter(Boolean).map(esc).join('<br>') +
    (c.nuovo ? '<br><span class="tag nuovo">Cliente nuovo, aggiunto dal telefono</span>' : '');
}

function disegnaInfoAzienda() {
  mostraRipeti();
  const el = $('#azienda-info');
  const az = trovaAzienda(S.ordine.azienda);
  const inp = $('#prodotto-input');
  if (!az) {
    el.innerHTML = '';
    inp.disabled = true;
    inp.placeholder = "Scegli prima l'azienda";
    return;
  }
  const n = listino().length;
  inp.disabled = false;
  inp.placeholder = n ? `Cerca tra ${n} prodotti (es. tav 90)` : 'Listino vuoto o non trovato';
  const parti = [];
  if (az.portoFranco) parti.push(`Porto franco <b>${esc(az.portoFranco.tipo === 'eur' ? fmtEuro(az.portoFranco.valore) : az.portoFranco.valore + ' ' + az.portoFranco.tipo)}</b>`);
  if (az.spedizione) parti.push(`spedizione <b>${fmtEuro(az.spedizione)}</b>`);
  if (az.mail) parti.push(esc(az.mail));
  let html = parti.join(' · ');
  if (az.scontoMerce && typeof az.scontoMerce === 'string') html += `<br><span class="nota">Sconto merce: ${esc(az.scontoMerce)}</span>`;
  el.innerHTML = html;
}

function etichetteRiga(r) {
  const t = [];
  if (r.scontoModo === 'omaggio') t.push('<span class="tag omaggio">Omaggio</span>');
  else if (r.scontoModo === 'pct' && r.scontoPct > 0) t.push(`<span class="tag sconto">−${esc(fmtNum(r.scontoPct))}% su ${fmtEuro(r.prezzoListino)}</span>`);
  if (r.nota && r.fissa) t.push('<span class="tag fissa">📌 nota fissa</span>');
  return t.join('');
}

function pannelloRiga(r) {
  const modo = r.scontoModo || '';
  return `<div class="riga-pannello">
    <label>Nota sull'articolo (nel PDF e nella mail all'azienda)</label>
    <textarea data-testo="nota" rows="2" placeholder="Es. confezione regalo, scadenza lunga…">${esc(r.nota || '')}</textarea>
    <label class="check"><input type="checkbox" data-check="fissa" ${r.fissa ? 'checked' : ''}> Fissa per ${esc(S.ordine.cliente || 'questo cliente')}: torna da sola nei prossimi ordini</label>
    <span class="etichetta">Sconto sulla riga</span>
    <div class="sconto-riga">
      <button type="button" data-sconto="" class="${modo === '' ? 'on' : ''}">Nessuno</button>
      <button type="button" data-sconto="pct" class="${modo === 'pct' ? 'on' : ''}">Sconto %</button>
      <button type="button" data-sconto="omaggio" class="${modo === 'omaggio' ? 'on' : ''}">Omaggio</button>
      ${modo === 'pct' ? `<input data-campo-sconto inputmode="decimal" placeholder="%" value="${fmtNum(r.scontoPct || '')}" aria-label="Sconto percentuale">` : ''}
    </div>
    <div class="info">Prezzo di listino ${fmtEuro(r.prezzoListino ?? r.prezzo)}</div>
    <div class="azioni"><button type="button" class="primario" data-azione="chiudi">Fatto</button></div>
  </div>`;
}

function disegnaRighe() {
  const box = $('#righe');
  box.innerHTML = S.ordine.righe.map((r, i) => {
    const sotto = [r.cod, r.imballo ? `${fmtNum(r.imballo)} pz/ct` : ''].filter(Boolean).join(' · ');
    const aperta = S.rigaAperta === i;
    const segni = !!(r.nota || r.scontoModo);
    return `<div class="riga" data-i="${i}">
      <div class="riga-top">
        <div class="riga-nome">${esc(r.nome)}${sotto ? `<small>${esc(sotto)}</small>` : ''}${etichetteRiga(r)}</div>
        <button class="matita${aperta || segni ? ' on' : ''}" data-azione="dettagli" aria-label="Nota e sconto" title="Nota e sconto">✎</button>
        <button class="x" data-azione="rimuovi" aria-label="Togli articolo">×</button>
      </div>
      ${r.nota && !aperta ? `<div class="riga-nota">${esc(r.nota)}</div>` : ''}
      <div class="riga-ctrl">
        <div class="qta">
          <button data-azione="meno" aria-label="Meno">−</button>
          <input data-campo="qta" inputmode="decimal" value="${fmtNum(r.qta)}" aria-label="Quantità">
          <button data-azione="piu" aria-label="Più">+</button>
        </div>
        <div class="unita">
          <button data-unita="ct" class="${r.unita === 'ct' ? 'on' : ''}">CT</button>
          <button data-unita="pz" class="${r.unita === 'pz' ? 'on' : ''}">PZ</button>
        </div>
        <div class="prezzo-box">€ <input data-campo="prezzo" inputmode="decimal" value="${fmtNum(r.prezzo)}" aria-label="Prezzo unitario"></div>
        <span class="riga-tot"></span>
      </div>
      ${aperta ? pannelloRiga(r) : ''}
    </div>`;
  }).join('');
  aggiornaTotali();
}

function aggiornaTotali() {
  const o = S.ordine;
  document.querySelectorAll('#righe .riga').forEach((el) => {
    const r = o.righe[el.dataset.i];
    el.querySelector('.riga-tot').textContent = fmtEuro(calcolaRiga(r).totale);
  });
  const t = calcolaTotali(o);
  const righe = [`<div><span>Somma <small>(${fmtNum(t.totCt)} ct · ${fmtNum(t.totPz)} pz)</small></span><span>${fmtEuro(t.somma)}</span></div>`];
  if (t.portoTipo) {
    righe.push(`<div><span>Spedizione <small>(franco ${esc(t.portoTesto)})</small></span><span>${t.spedizione ? fmtEuro(t.spedizione) : 'gratis'}</span></div>`);
  }
  if (t.scontoPag) righe.push(`<div><span>Sconto pagamento</span><span>${pct(t.scontoPag)}</span></div>`);
  else if (t.scontoPagTesto) righe.push(`<div><span>Sconto pagamento</span><span>${esc(t.scontoPagTesto)}</span></div>`);
  if (t.extra) righe.push(`<div><span>Sconto extra</span><span>${pct(t.extra)}</span></div>`);
  righe.push(`<div class="finale"><span>Totale</span><span>${fmtEuro(t.totale)}</span></div>`);
  if (t.mancante) {
    const sped = t.spedizione ? ` e risparmi ${fmtEuro(t.spedizione)} di spedizione` : '';
    righe.push(`<span class="mancante">Mancano <b>${esc(t.mancante)}</b> al porto franco${sped}</span>`);
  } else if (t.portoTipo) {
    righe.push('<span class="mancante ok">Porto franco raggiunto</span>');
  }
  $('#totali').innerHTML = righe.join('');
  $('#barra-totale').textContent = fmtEuro(t.totale);
}

// ---------------------------------------------------------------- scelta cliente / azienda

function collegaRicerca(inputSel, listaSel, fonte, testo, sottotitolo, scegli) {
  const inp = $(inputSel), ul = $(listaSel);
  const mostra = () => {
    const q = inp.value;
    const trovati = q.trim() ? cerca(fonte(), q, testo, 30) : fonte().slice(0, 30);
    ul.innerHTML = trovati.length
      ? trovati.map((v, i) => `<li data-i="${i}">${esc(testo(v))}${sottotitolo(v) ? `<small>${esc(sottotitolo(v))}</small>` : ''}</li>`).join('')
      : '<li class="vuoto">Nessun risultato</li>';
    ul._trovati = trovati;
    ul.hidden = false;
  };
  inp.addEventListener('input', mostra);
  inp.addEventListener('focus', () => { inp.select(); mostra(); });
  inp.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; scegli(null, inp.value.trim()); }, 200));
  ul.addEventListener('pointerdown', (e) => e.preventDefault());
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const v = ul._trovati[li.dataset.i];
    inp.value = testo(v);
    ul.hidden = true;
    inp.blur();
    scegli(v, testo(v));
  });
}

function sceltaCliente(c, testo) {
  const o = S.ordine;
  if (c) {
    o.cliente = c.nome;
    const pagamenti = (S.dati?.pagamenti || []).map((p) => p.nome);
    if (!o.pagamento && pagamenti.includes(c.pagamento)) o.pagamento = c.pagamento;
  } else {
    if (testo === o.cliente) return;
    o.cliente = testo;
  }
  applicaNoteFisse(o.righe, true);
  disegnaPagamenti();
  disegnaInfoCliente();
  disegnaRighe();
  disegnaAvvisoEmail();
  salvaBozza();
}

function sceltaAzienda(az, testo) {
  const o = S.ordine;
  const nome = az ? az.nome : (trovaAzienda(testo) ? testo : '');
  if (nome === o.azienda) { $('#azienda-input').value = o.azienda; return; }
  if (o.righe.length && !confirm(`Cambiando azienda tolgo i ${o.righe.length} articoli già inseriti. Procedo?`)) {
    $('#azienda-input').value = o.azienda;
    return;
  }
  o.azienda = nome;
  o.righe = [];
  $('#azienda-input').value = nome;
  const nuova = trovaAzienda(nome);
  if (nuova && typeof nuova.scontoMerce === 'number' && !o.scontoExtra) {
    o.scontoExtra = fmtNum(Math.abs(nuova.scontoMerce * 100));
    $('#sconto-extra').value = o.scontoExtra;
  }
  $('#prodotto-input').value = '';
  $('#prodotto-lista').innerHTML = '';
  disegnaInfoAzienda();
  disegnaRighe();
  disegnaAvvisoEmail();
  salvaBozza();
}

// ---------------------------------------------------------------- articoli

function cercaProdotti() {
  const q = $('#prodotto-input').value;
  const ul = $('#prodotto-lista');
  if (!q.trim()) { ul.innerHTML = ''; return; }
  const trovati = cerca(listino(), q, (p) => p[1] + ' ' + p[0], 40);
  ul._trovati = trovati;
  ul.innerHTML = trovati.length
    ? trovati.map((p, i) => {
        const det = [p[0], p[2] !== null ? fmtEuro(p[2]) : 'prezzo mancante', p[3] ? `${fmtNum(p[3])} pz/ct` : ''].filter(Boolean).join(' · ');
        return `<li data-i="${i}">${esc(p[1])}<small>${esc(det)}</small></li>`;
      }).join('')
    : '<li class="vuoto">Nessun prodotto con tutte queste parole</li>';
}

function aggiungiProdotto(p) {
  const o = S.ordine;
  const esistente = o.righe.find((r) => r.nome === p[1] && r.cod === p[0]);
  if (esistente) {
    esistente.qta += 1;
  } else {
    const r = { cod: p[0], nome: p[1], prezzo: p[2] || 0, prezzoListino: p[2] || 0, imballo: p[3] || 0, qta: 1, unita: p[3] ? 'ct' : 'pz' };
    applicaNoteFisse([r]);
    o.righe.push(r);
  }
  $('#prodotto-input').value = '';
  $('#prodotto-lista').innerHTML = '';
  disegnaRighe();
  salvaBozza();
  avviso(esistente ? `${p[1]}: quantità ${fmtNum(esistente.qta)}` : `Aggiunto: ${p[1]}`);
}

// ---------------------------------------------------------------- ripeti ultimo ordine

const isoDaIt = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const stessoNome = (a, b) => norm(a).trim() === norm(b).trim();

// Ultimo ordine di questo cliente con questa azienda salvato sul telefono (anche bozze)
async function ultimoLocale(cliente, azienda) {
  const trovati = (await ordiniVisibili()).filter((r) => r.payload && r.id !== S.ordine.id &&
    stessoNome(r.payload.cliente, cliente) && stessoNome(r.payload.azienda, azienda) && r.payload.righe.length);
  trovati.sort((a, b) => (b.payload.data || '').localeCompare(a.payload.data || '') || b.creato - a.creato);
  const r = trovati[0];
  return r ? { id: r.id, data: r.payload.data, righe: r.payload.righe } : null;
}

// Rifà le righe con i prezzi del listino attuale; tiene il prezzo vecchio solo se l'articolo non c'è più
function righeDaRipetere(vecchie) {
  const lis = listino();
  let fuori = 0;
  const righe = vecchie.map((v) => {
    const p = lis.find((x) => v.cod && String(x[0]) === v.cod && x[1] === v.nome)
      || (v.cod && lis.find((x) => String(x[0]) === v.cod))
      || lis.find((x) => x[1] === v.nome);
    if (!p) fuori++;
    const imballo = p ? (p[3] || 0) : (v.imballo || 0);
    let unita = v.unita, qta = v.qta;
    if (!unita) {
      // Dal foglio arrivano pezzi e cartoni: cartoni se sono interi, altrimenti pezzi
      const ct = Math.round(v.ct * 1000) / 1000;
      if (imballo && ct > 0 && Number.isInteger(ct)) { unita = 'ct'; qta = ct; } else { unita = 'pz'; qta = v.pz; }
    }
    if (unita === 'ct' && !imballo) { unita = 'pz'; qta = v.pz || qta; }
    const prezzo = p && p[2] !== null ? p[2] : (v.prezzo || 0);
    return {
      cod: p ? p[0] : v.cod, nome: p ? p[1] : v.nome,
      prezzo, prezzoListino: prezzo,
      imballo, qta, unita,
    };
  }).filter((r) => r.qta > 0);
  applicaNoteFisse(righe);
  return { righe, fuori };
}

async function ripetiUltimo() {
  const o = S.ordine;
  if (!o.cliente || !trovaAzienda(o.azienda)) return avviso("Scegli prima cliente e azienda", true);
  const btn = $('#btn-ripeti');
  btn.disabled = true;
  try {
    let ultimo = await ultimoLocale(o.cliente, o.azienda);
    if (navigator.onLine && S.imp.url) {
      try {
        const { ordine } = await api('ultimo', { cliente: o.cliente, azienda: o.azienda });
        if (ordine && ordine.id !== o.id && ordine.righe.length) {
          const remoto = { ...ordine, data: isoDaIt(ordine.data) };
          if (!ultimo || remoto.data > ultimo.data) ultimo = remoto;
        }
      } catch (err) {
        if (!ultimo) throw err;
      }
    }
    if (!ultimo) return avviso(`Nessun ordine precedente di ${o.cliente} con ${o.azienda}`, true);

    const { righe, fuori } = righeDaRipetere(ultimo.righe);
    if (!righe.length) return avviso("L'ultimo ordine non ha articoli da ripetere", true);
    if (o.righe.length && !confirm(`Sostituisco i ${o.righe.length} articoli già inseriti con i ${righe.length} dell'ordine del ${fmtData(ultimo.data)}?`)) return;
    o.righe = righe;
    disegnaRighe();
    salvaBozza();
    let msg = `Caricati ${righe.length} articoli dall'ordine del ${fmtData(ultimo.data)}, con i prezzi di listino attuali`;
    if (fuori) msg += `. ${fuori} non più in listino: tenuto il prezzo vecchio`;
    avviso(msg);
  } catch (err) {
    avviso(err.rete ? "Senza rete trovo solo gli ordini salvati su questo telefono" : 'Ultimo ordine non trovato: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function gestisciRighe(e) {
  const el = e.target.closest('.riga');
  if (!el) return;
  const r = S.ordine.righe[el.dataset.i];
  const azione = e.target.dataset.azione;
  const unita = e.target.dataset.unita;
  const sconto = e.target.dataset.sconto;
  if (azione === 'rimuovi') {
    S.ordine.righe.splice(el.dataset.i, 1);
    S.rigaAperta = -1;
    disegnaRighe();
  } else if (azione === 'dettagli' || azione === 'chiudi') {
    const i = Number(el.dataset.i);
    if (S.rigaAperta >= 0 && S.ordine.righe[S.rigaAperta]) salvaNotaFissa(S.ordine.righe[S.rigaAperta]);
    S.rigaAperta = (azione === 'dettagli' && S.rigaAperta !== i) ? i : -1;
    disegnaRighe();
    if (S.rigaAperta === i && !r.nota) document.querySelector(`#righe .riga[data-i="${i}"] textarea`)?.focus();
  } else if (sconto !== undefined) {
    if (r.prezzoListino === undefined) r.prezzoListino = r.prezzo;
    r.scontoModo = sconto;
    applicaSconto(r);
    disegnaRighe();
    if (sconto === 'pct') document.querySelector(`#righe .riga[data-i="${el.dataset.i}"] [data-campo-sconto]`)?.focus();
  } else if (azione === 'piu' || azione === 'meno') {
    r.qta = Math.max(0, r.qta + (azione === 'piu' ? 1 : -1));
    el.querySelector('[data-campo="qta"]').value = fmtNum(r.qta);
    aggiornaTotali();
  } else if (unita && unita !== r.unita) {
    r.unita = unita;
    el.querySelectorAll('.unita button').forEach((b) => b.classList.toggle('on', b.dataset.unita === unita));
    aggiornaTotali();
  } else {
    return;
  }
  salvaBozza();
}

function modificaRiga(e) {
  const el = e.target.closest('.riga');
  if (!el) return;
  const r = S.ordine.righe[el.dataset.i];
  const { campo, testo, check } = e.target.dataset;
  if (campo) {
    r[campo] = numIt(e.target.value);
    // Prezzo cambiato a mano: diventa il nuovo prezzo di partenza se non c'è sconto
    if (campo === 'prezzo' && !r.scontoModo) r.prezzoListino = r.prezzo;
  } else if (testo === 'nota') {
    r.nota = e.target.value;
  } else if (check === 'fissa') {
    r.fissa = e.target.checked;
  } else if (e.target.matches('[data-campo-sconto]')) {
    r.scontoPct = Math.min(100, Math.abs(numIt(e.target.value)));
    applicaSconto(r);
    el.querySelector('[data-campo="prezzo"]').value = fmtNum(r.prezzo);
  } else {
    return;
  }
  aggiornaTotali();
  salvaBozza();
}

// Prezzo netto della riga dallo sconto scelto
function applicaSconto(r) {
  const base = r.prezzoListino ?? r.prezzo;
  if (r.scontoModo === 'omaggio') r.prezzo = 0;
  else if (r.scontoModo === 'pct') r.prezzo = Math.round(base * (1 - (r.scontoPct || 0) / 100) * 10000) / 10000;
  else r.prezzo = base;
}

// ---------------------------------------------------------------- note fisse per cliente

const chiaveNota = (cliente, azienda) => (n) => stessoNome(n[0], cliente) && stessoNome(n[1], azienda);
const stessoArticolo = (n, r) => (n[2] && r.cod && String(n[2]) === String(r.cod)) || stessoNome(n[3], r.nome);

// Mette sulle righe le note fisse del cliente; con cambioCliente toglie prima quelle del cliente precedente
function applicaNoteFisse(righe, cambioCliente = false) {
  const o = S.ordine;
  const note = (S.dati?.noteClienti || []).filter(chiaveNota(o.cliente, o.azienda));
  for (const r of righe) {
    if (cambioCliente && r.fissaIniziale) { r.nota = ''; r.fissa = false; r.fissaIniziale = false; }
    if (r.nota || !o.cliente) continue;
    const n = note.find((x) => stessoArticolo(x, r));
    if (n) { r.nota = n[4]; r.fissa = true; r.fissaIniziale = true; }
  }
}

// Aggiorna subito la nota fissa sul telefono e, se c'è rete, nel file Ordini Dati.
// Se la rete manca la nota parte comunque con l'ordine.
function salvaNotaFissa(r) {
  const o = S.ordine;
  if (!o.cliente || !o.azienda || !S.dati) return;
  const nota = String(r.nota || '').trim();
  const vuole = !!(r.fissa && nota);
  if (!vuole && !r.fissaIniziale) return;
  const note = S.dati.noteClienti || (S.dati.noteClienti = []);
  const stesso = chiaveNota(o.cliente, o.azienda);
  const i = note.findIndex((n) => stesso(n) && stessoArticolo(n, r));
  if (vuole && i >= 0 && note[i][4] === nota) return;
  if (i >= 0) note.splice(i, 1);
  if (vuole) note.push([o.cliente, o.azienda, r.cod || '', r.nome, nota]);
  r.tolta = !vuole;
  r.fissaIniziale = vuole;
  DB.set('dati', S.dati);
  if (navigator.onLine && S.imp.url) {
    api('nota', { nota: { cliente: o.cliente, azienda: o.azienda, cod: r.cod || '', nome: r.nome, nota: vuole ? nota : '' } })
      .catch(() => { /* riparte con l'invio dell'ordine */ });
  }
  avviso(vuole ? `Nota fissa salvata per ${o.cliente}` : `Nota fissa tolta per ${o.cliente}`);
}

// ---------------------------------------------------------------- salvataggio e coda

function preparaPayload(o) {
  const righe = o.righe.filter((r) => r.qta > 0);
  const t = calcolaTotali({ ...o, righe });
  return {
    id: o.id,
    data: o.data,
    cliente: o.cliente,
    azienda: o.azienda,
    pagamento: o.pagamento,
    consegna: o.consegna,
    note: o.note,
    scontoExtra: t.extra,
    bozze: o.bozze,
    righe: righe.map((r) => {
      const c = calcolaRiga(r);
      const nota = String(r.nota || '').trim();
      const sconto = r.scontoModo === 'omaggio' ? 'omaggio' : (r.scontoModo === 'pct' && r.scontoPct > 0 ? r.scontoPct : '');
      return {
        cod: r.cod, nome: r.nome, unita: r.unita, qta: r.qta, pz: c.pz, ct: c.ct, imballo: r.imballo, prezzo: r.prezzo, totale: c.totale,
        nota, sconto, prezzoListino: r.prezzoListino ?? r.prezzo,
        notaFissa: !!(r.fissa && nota), togliFissa: !!(r.tolta && !(r.fissa && nota)),
      };
    }),
    anagrafica: anagraficaNuovo(o.cliente),
    totali: { somma: t.somma, spedizione: t.spedizione, portoTipo: t.portoTipo, scontoPagamento: t.scontoPag, totale: t.totale },
  };
}

function erroreInvio(p) {
  if (!p.cliente) return 'Manca il cliente';
  if (!trovaAzienda(p.azienda)) return "Manca l'azienda";
  if (!p.righe.length) return 'Nessun articolo con quantità';
  return '';
}

function confermaInvio(p) {
  const mancano = mancanzeEmail(p).map((t) => '⚠ ' + t).join('\n');
  return confirm(`Invio l'ordine di ${p.cliente} (${fmtEuro(p.totali.totale)})?\nDopo l'invio non si potrà più modificare.` + (mancano ? '\n\n' + mancano : ''));
}

// Gli ordini eliminati restano come segnaposto finché il foglio non lo sa
const ordiniVisibili = async () => (await DB.ordini()).filter((o) => !o.eliminato);
const trovaRecord = async (id) => (await ordiniVisibili()).find((x) => x.id === id);

// Ogni modifica a un ordine salvato va poi copiata sul foglio (sporco = da copiare)
async function segna(rec) {
  rec.aggiornato = Date.now();
  rec.sporco = true;
  await DB.salvaOrdine(rec);
}

// Salva l'ordine sul telefono come bozza; con invia=true lo mette in coda per il server
async function salvaOrdine(invia) {
  const o = S.ordine;
  if (S.rigaAperta >= 0 && o.righe[S.rigaAperta]) salvaNotaFissa(o.righe[S.rigaAperta]);
  S.rigaAperta = -1;
  const payload = preparaPayload(o);
  if (invia) {
    const errore = erroreInvio(payload);
    if (errore) return avviso(errore, true);
    if (!confermaInvio(payload)) return;
  } else if (!o.cliente && !o.azienda && !o.righe.length) {
    return avviso("L'ordine è vuoto", true);
  }

  const vecchio = await trovaRecord(o.id);
  if (vecchio && (vecchio.stato === 'invio' || vecchio.stato === 'inviato')) {
    return avviso('Questo ordine è già stato inviato e non si può più modificare', true);
  }
  const { salvato, ...modulo } = o;
  await segna({ id: o.id, creato: vecchio?.creato || Date.now(), stato: invia ? 'attesa' : 'bozza', payload, ordine: modulo });
  S.ordine = nuovoOrdine();
  await DB.set('bozza', S.ordine);
  disegnaOrdine();
  window.scrollTo(0, 0);
  mostraVista('coda');
  if (invia) {
    avviso(navigator.onLine ? 'Invio in corso…' : 'Partirà appena torna la rete');
  } else {
    avviso('Salvato. Lo trovi in Ordini, da modificare o inviare');
  }
  sincronizza();
}

async function modificaSalvato(id) {
  const rec = await trovaRecord(id);
  if (!rec || !rec.ordine || rec.stato === 'invio' || rec.stato === 'inviato') return avviso('Questo ordine non si può più modificare', true);
  const corrente = S.ordine;
  if (corrente.id !== id && !corrente.salvato && corrente.righe.length &&
      !confirm("L'ordine che stai scrivendo non è salvato e verrà perso. Procedo?")) return;
  if (rec.stato !== 'bozza') {
    // Tolto dalla coda finché non lo reinvii
    rec.stato = 'bozza';
    rec.errore = '';
    await segna(rec);
  }
  S.ordine = { ...structuredClone(rec.ordine), salvato: true };
  await DB.set('bozza', S.ordine);
  disegnaOrdine();
  mostraVista('nuovo');
  window.scrollTo(0, 0);
}

async function inviaSalvato(id) {
  const rec = await trovaRecord(id);
  if (!rec || rec.stato !== 'bozza') return;
  const errore = erroreInvio(rec.payload);
  if (errore) return avviso(errore + ': premi Modifica per completarlo', true);
  if (!confermaInvio(rec.payload)) return;
  rec.stato = 'attesa';
  await segna(rec);
  await chiudiSeAperto(id);
  if (!navigator.onLine) avviso('Partirà appena torna la rete');
  sincronizza();
}

// Se l'ordine è aperto in "Nuovo", lo sostituisce con uno vuoto
async function chiudiSeAperto(id) {
  if (S.ordine.id !== id) return;
  S.ordine = nuovoOrdine();
  await DB.set('bozza', S.ordine);
  disegnaOrdine();
}

async function sincronizza(anche_errori = false) {
  // Se un giro è già in corso ne serve un altro subito dopo, per le modifiche appena fatte
  if (S.sincronizzando) { S.ripeti = true; await disegnaCoda(); return; }
  if (!navigator.onLine || !S.imp.url) { await disegnaCoda(); return; }
  S.sincronizzando = true;
  S.ripeti = false;
  try {
    const lista = (await ordiniVisibili())
      .filter((o) => o.stato === 'attesa' || (anche_errori && o.stato === 'errore'))
      .sort((a, b) => a.creato - b.creato);
    for (const o of lista) {
      o.stato = 'invio';
      await DB.salvaOrdine(o);
      await disegnaCoda();
      try {
        o.esito = await api('ordine', { ordine: o.payload });
        o.stato = 'inviato';
        if (S.storico) S.storico.preso = 0;
        o.errore = '';
      } catch (err) {
        o.stato = err.rete ? 'attesa' : 'errore';
        o.errore = err.message;
        if (err.rete) { await DB.salvaOrdine(o); return; }
        await segna(o);
        continue;
      }
      await segna(o);
    }
    await allinea();
    await inviaClientiNuovi();
  } catch (err) {
    if (!err.rete) console.warn('Allineamento ordini non riuscito:', err.message);
  } finally {
    S.sincronizzando = false;
    await disegnaCoda();
    if (S.ripeti) sincronizza();
  }
}

// Copia sul foglio gli ordini cambiati qui, poi prende quelli cambiati sugli altri dispositivi.
// Vince la modifica più recente; il foglio non riporta mai indietro un ordine inviato.
async function allinea() {
  for (const rec of (await DB.ordini()).filter((r) => r.sporco && r.stato !== 'invio')) {
    const { sporco, erroreFoglio, ...daSalvare } = rec;
    try {
      const { record } = await api('salva', { record: daSalvare });
      await applicaDalFoglio(record, rec.aggiornato);
    } catch (err) {
      if (err.rete) throw err;
      rec.erroreFoglio = 'Non copiato sul foglio: ' + err.message;
      await DB.salvaOrdine(rec);
    }
  }
  const { ordini } = await api('salvati');
  const locali = new Map((await DB.ordini()).map((r) => [r.id, r]));
  for (const rec of ordini) {
    const loc = locali.get(rec.id);
    if (loc && (loc.sporco || loc.stato === 'invio' || (loc.aggiornato || 0) >= rec.aggiornato)) continue;
    await applicaDalFoglio(rec);
  }
}

async function applicaDalFoglio(rec, inviato) {
  const attuale = (await DB.ordini()).find((r) => r.id === rec.id);
  // Cambiato di nuovo qui mentre era in viaggio: resta da copiare
  if (attuale && inviato && attuale.aggiornato > inviato) return;
  if (rec.eliminato) {
    await DB.eliminaOrdine(rec.id);
    await chiudiSeAperto(rec.id);
  } else {
    await DB.salvaOrdine(rec);
  }
}

const ETICHETTE_STATO = { bozza: 'Da inviare', attesa: 'In attesa', invio: 'Invio…', inviato: 'Inviato', errore: 'Errore' };

async function disegnaCoda() {
  const ordini = (await ordiniVisibili()).sort((a, b) => b.creato - a.creato);
  const daInviare = ordini.filter((o) => o.stato !== 'inviato').length;
  const badge = $('#badge-coda');
  badge.hidden = !daInviare;
  badge.textContent = daInviare;
  disegnaRete(daInviare);

  const ul = $('#lista-ordini');
  if (!ordini.length) { ul.innerHTML = '<li class="vuoto-lista">Nessun ordine salvato</li>'; return; }
  const q = $('#cerca-ordini').value;
  const visti = q.trim()
    ? cerca(ordini, q, (o) => `${o.payload.cliente} ${o.payload.azienda} ${fmtData(o.payload.data)} ${ETICHETTE_STATO[o.stato]}`, 500)
    : ordini;
  if (!visti.length) { ul.innerHTML = '<li class="vuoto-lista">Nessun ordine con queste parole</li>'; return; }
  ul.innerHTML = visti.map((o) => {
    const p = o.payload;
    const e = o.esito || {};
    let msg = '';
    if (o.stato === 'inviato') {
      msg = [e.duplicato ? 'Era già registrato.' : `Scheda: ${e.foglio}`, ...(e.bozze || [])].join('\n');
    } else if (o.errore) {
      msg = o.errore;
    }
    if (o.erroreFoglio) msg = [msg, o.erroreFoglio].filter(Boolean).join('\n');
    const azioni = [];
    if (e.pdf) {
      azioni.push(`<a href="${esc(e.pdf)}" target="_blank" rel="noopener">Apri PDF</a>`);
      azioni.push(`<button class="secondario" data-condividi="${esc(o.id)}">Condividi</button>`);
    }
    const modificabile = o.ordine && o.stato !== 'invio' && o.stato !== 'inviato';
    if (o.stato === 'bozza') azioni.push(`<button class="primario" data-invia="${esc(o.id)}">Invia</button>`);
    if (modificabile) azioni.push(`<button class="secondario" data-modifica="${esc(o.id)}">Modifica</button>`);
    if (o.stato === 'errore') azioni.push(`<button class="secondario" data-riprova="${esc(o.id)}">Riprova</button>`);
    if (o.stato !== 'invio') azioni.push(`<button class="secondario" data-elimina="${esc(o.id)}">Elimina</button>`);
    return `<li>
      <div class="testa"><b>${esc(p.cliente)} — ${esc(p.azienda)}</b><span class="stato ${o.stato}">${ETICHETTE_STATO[o.stato]}</span></div>
      <div class="det">${fmtData(p.data)} · ${p.righe.length} articoli · ${fmtEuro(p.totali.totale)}</div>
      ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
      <div class="azioni">${azioni.join('')}</div>
    </li>`;
  }).join('');
}

async function gestisciCoda(e) {
  const { riprova, elimina, invia, modifica, condividi } = e.target.dataset;
  if (condividi) {
    const o = await trovaRecord(condividi);
    if (o?.esito?.pdf) condividiPdf(o.esito.pdf, o.payload.cliente, o.payload.azienda, o.payload.data);
  } else if (invia) {
    inviaSalvato(invia);
  } else if (modifica) {
    modificaSalvato(modifica);
  } else if (riprova) {
    sincronizza(true);
  } else if (elimina) {
    const o = await trovaRecord(elimina);
    if (!o) return;
    const avvisoTesto = o.stato === 'inviato'
      ? "Tolgo l'ordine dall'elenco dell'app su tutti i dispositivi (resta nel foglio e su Drive). Procedo?"
      : 'Questo ordine non è ancora stato inviato: eliminandolo si perde, anche sugli altri dispositivi. Procedo?';
    if (!confirm(avvisoTesto)) return;
    await segna({ id: elimina, creato: o.creato, eliminato: true });
    await chiudiSeAperto(elimina);
    sincronizza();
  }
}

function disegnaRete(daInviare) {
  const el = $('#stato-rete');
  const online = navigator.onLine;
  el.className = 'pill' + (online ? '' : ' offline');
  el.textContent = (online ? 'Online' : 'Offline') + (daInviare ? ` · ${daInviare} da inviare` : '');
}

// Il PDF sta su Drive: si condivide il link (WhatsApp, mail…); senza menu di condivisione lo copia
async function condividiPdf(url, cliente, azienda, data) {
  const testo = `Ordine ${azienda} del ${fmtData(data)} - ${cliente}`;
  if (navigator.share) {
    try { await navigator.share({ title: testo, text: testo, url }); } catch (err) { /* annullato */ }
    return;
  }
  try { await navigator.clipboard.writeText(url); avviso('Link del PDF copiato'); } catch (err) { prompt('Link del PDF:', url); }
}

// ---------------------------------------------------------------- server

const DEMO = 'demo';

async function api(azione, extra = {}) {
  const { url, token } = S.imp;
  if (!url) throw new Error("Imposta l'indirizzo dell'app web nelle Impostazioni.");
  if (url === DEMO) return apiDemo(azione, extra);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, azione, ...extra }),
    });
  } catch {
    const err = new Error('Rete non disponibile');
    err.rete = true;
    throw err;
  }
  let j;
  try { j = await res.json(); } catch { throw new Error(`Risposta non valida dal server (${res.status}). Controlla l'indirizzo e che l'app web sia pubblicata per "Chiunque".`); }
  if (!j.ok) throw new Error(j.errore || 'Errore sconosciuto');
  return j;
}

// Modalità prova: dati finti da demo.json, nessun invio reale
async function apiDemo(azione, extra) {
  await new Promise((r) => setTimeout(r, 600));
  if (azione === 'dati') return (await fetch('demo.json')).json();
  if (azione === 'storico') return storicoDemo();
  if (azione === 'nota' || azione === 'cliente') return {};
  if (azione === 'ordine') return { id: extra.ordine.id, foglio: `${extra.ordine.cliente} (prova)`, pdf: '', bozze: ['Modalità prova: nessuna bozza creata'] };
  // Il "foglio" della prova è il localStorage del browser
  const foglio = JSON.parse(localStorage.getItem('demo-foglio') || '{}');
  if (azione === 'salvati') return { ordini: Object.values(foglio) };
  if (azione === 'salva') {
    const r = extra.record, v = foglio[r.id];
    if (v && (r.aggiornato <= v.aggiornato || (v.stato === 'inviato' && !r.eliminato && r.stato !== 'inviato'))) return { record: v };
    foglio[r.id] = r;
    localStorage.setItem('demo-foglio', JSON.stringify(foglio));
    return { record: r };
  }
  return {};
}

// Ordini finti degli ultimi due anni per provare Clienti e Vendite
async function storicoDemo() {
  const d = await (await fetch('demo.json')).json();
  const ordini = {}, righe = [];
  let seme = 7;
  const rnd = () => (seme = (seme * 16807) % 2147483647) / 2147483647;
  const isoFa = (g) => { const x = new Date(Date.now() - g * 864e5); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const piani = [['Bottega Rossi', 'Pastificio Prova', 30, 6], ['Bottega Rossi', 'Cantina Demo', 60, 3], ['Gastronomia Bianchi', 'Pastificio Prova', 45, 70],
    ['Enoteca Verdi', 'Cantina Demo', 25, 40], ['Enoteca Verdi', 'Dolci Esempio', 90, 20]];
  piani.forEach(([cli, az, ogni, primo], pi) => {
    const lis = d.listini[az];
    let fa = primo;
    for (let n = 0; n < 10 && fa < 700; n++, fa += ogni + Math.round(rnd() * 10 - 5)) {
      const id = `demo-${pi}-${n}`;
      let tot = 0;
      lis.forEach((p, j) => {
        if (j > 0 && rnd() < 0.45) return;
        const ct = 1 + Math.floor(rnd() * 3);
        const pz = p[3] ? ct * p[3] : ct * 6;
        const t = Math.round(pz * p[2] * 100) / 100;
        tot += t;
        righe.push([id, p[0], p[1], pz, p[3] ? ct : 0, p[2], t, '', '']);
      });
      ordini[id] = [isoFa(fa), cli, az, Math.round(tot * 100) / 100, '', n % 2 ? 'foglio' : 'app'];
    }
  });
  return { ordini, righe };
}

async function aggiornaDati(silenzioso = false) {
  const btn = $('#btn-aggiorna');
  btn.disabled = true;
  btn.textContent = 'Scarico…';
  try {
    await inviaClientiNuovi();
    const dati = await api('dati');
    for (const c of (await DB.get('clientiNuovi')) || []) {
      if (!dati.clienti.some((x) => stessoNome(x.nome, c.nome))) dati.clienti.push(c);
    }
    dati.clienti.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
    S.dati = dati;
    await DB.set('dati', dati);
    disegnaOrdine();
    disegnaInfoDati();
    if (!silenzioso) avviso('Clienti e listini aggiornati');
  } catch (err) {
    if (!silenzioso) avviso(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aggiorna clienti e listini';
  }
}

function disegnaInfoDati() {
  const d = S.dati;
  const el = $('#info-dati');
  if (!d) { el.innerHTML = 'Nessun dato scaricato. Configura il collegamento e premi Aggiorna.'; return; }
  const prodotti = Object.values(d.listini).reduce((n, l) => n + l.length, 0);
  const quando = new Date(d.aggiornato).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  el.innerHTML = `<b>${d.clienti.length}</b> clienti · <b>${d.aziende.length}</b> aziende · <b>${prodotti}</b> prodotti<br>Aggiornati il ${esc(quando)}`;
}

// ---------------------------------------------------------------- clienti nuovi dal telefono

const CAMPI_CLIENTE = ['nome', 'indirizzo', 'cap', 'citta', 'prov', 'piva', 'cf', 'sdi', 'pec', 'mail', 'tel', 'referente', 'cell', 'pagamento'];

// Il cliente aggiunto dal telefono viaggia con l'ordine: così la scheda ha i suoi dati anche se non è in anagrafica
function anagraficaNuovo(nome) {
  const c = trovaCliente(nome);
  if (!c || !c.nuovo) return undefined;
  const out = {};
  CAMPI_CLIENTE.forEach((k) => { out[k] = c[k] || ''; });
  return out;
}

function apriNuovoCliente() {
  if (!S.dati) return avviso('Scarica prima clienti e listini dalle Impostazioni', true);
  $('#form-cliente').reset();
  const pag = (S.dati.pagamenti || []).map((p) => p.nome).filter((n) => !/^seleziona/i.test(n));
  $('#nc-pagamento').innerHTML = '<option value="">—</option>' + pag.map((n) => `<option>${esc(n)}</option>`).join('');
  const scritto = $('#cliente-input').value.trim();
  if (scritto && !trovaCliente(scritto)) $('#nc-nome').value = scritto;
  $('#dlg-cliente').showModal();
}

async function salvaNuovoCliente(e) {
  e.preventDefault();
  const f = new FormData($('#form-cliente'));
  const c = { nuovo: true };
  CAMPI_CLIENTE.forEach((k) => { c[k] = String(f.get(k) || '').trim(); });
  c.prov = c.prov.toUpperCase();
  if (!c.nome) return avviso('Scrivi la ragione sociale', true);
  if (S.dati.clienti.some((x) => stessoNome(x.nome, c.nome))) return avviso('Questo cliente è già in elenco', true);
  S.dati.clienti.push(c);
  S.dati.clienti.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  await DB.set('dati', S.dati);
  await DB.set('clientiNuovi', [...((await DB.get('clientiNuovi')) || []), c]);
  $('#dlg-cliente').close();
  $('#cliente-input').value = c.nome;
  sceltaCliente(c, c.nome);
  avviso(`${c.nome} aggiunto ai clienti`);
  inviaClientiNuovi();
}

// Manda al file Ordini Dati i clienti aggiunti qui; senza rete restano in attesa
async function inviaClientiNuovi() {
  if (!navigator.onLine || !S.imp.url) return;
  const attesa = (await DB.get('clientiNuovi')) || [];
  if (!attesa.length) return;
  const resto = [];
  for (let i = 0; i < attesa.length; i++) {
    try {
      await api('cliente', { cliente: attesa[i] });
    } catch (err) {
      if (err.rete) { resto.push(...attesa.slice(i)); break; }
      resto.push(attesa[i]);
    }
  }
  await DB.set('clientiNuovi', resto);
}

// ---------------------------------------------------------------- storico (Clienti e Vendite)

const VITA_STORICO = 3600 * 1000;
const giorniDa = (iso) => Math.round((Date.parse(oggiIso()) - Date.parse(iso)) / 864e5);
const quandoFa = (g) => g <= 0 ? 'oggi' : g === 1 ? 'ieri' : `${g} giorni fa`;

async function caricaStorico(forza = false) {
  if (!S.storico) S.storico = (await DB.get('storico')) || null;
  const vecchio = !S.storico || Date.now() - (S.storico.preso || 0) > VITA_STORICO;
  if ((forza || vecchio) && navigator.onLine && S.imp.url) {
    try {
      const r = await api('storico');
      S.storico = { ordini: r.ordini, righe: r.righe, preso: Date.now() };
      S.indice = null;
      await DB.set('storico', S.storico);
    } catch (err) {
      if (forza || !S.storico) avviso('Storico non scaricato: ' + err.message, true);
    }
  }
  return S.storico;
}

function indiceStorico() {
  if (S.indice) return S.indice;
  const ordini = new Map();
  for (const [id, v] of Object.entries(S.storico?.ordini || {})) {
    ordini.set(id, { id, data: v[0], cliente: v[1], azienda: v[2], totale: v[3], pdf: v[4], origine: v[5], righe: [] });
  }
  for (const r of S.storico?.righe || []) {
    const o = ordini.get(r[0]);
    if (o) o.righe.push({ cod: r[1], nome: r[2], pz: Math.abs(r[3]), ct: Math.abs(r[4]), prezzo: r[5], totale: r[6], nota: r[7], sconto: r[8] });
  }
  const perCliente = new Map();
  for (const o of ordini.values()) {
    const k = norm(o.cliente).trim();
    if (!perCliente.has(k)) perCliente.set(k, { nome: o.cliente, ordini: [] });
    perCliente.get(k).ordini.push(o);
  }
  for (const c of perCliente.values()) c.ordini.sort((a, b) => b.data.localeCompare(a.data));
  S.indice = { ordini, perCliente };
  return S.indice;
}

// Ogni quanti giorni torna un ordine (servono almeno due date diverse)
function frequenza(date) {
  const d = [...new Set(date)].sort();
  if (!d.length) return null;
  const ultimo = d[d.length - 1];
  const ogni = d.length > 1 ? Math.round((Date.parse(ultimo) - Date.parse(d[0])) / 864e5 / (d.length - 1)) : 0;
  const da = giorniDa(ultimo);
  return { volte: d.length, ultimo, ogni, da, scaduto: ogni > 0 && da >= ogni, ritardo: ogni > 0 ? da / ogni : 0 };
}

const vendite = (ordini) => ordini.filter((o) => o.origine !== 'reso');

function infoStorico() {
  if (!S.storico) return navigator.onLine ? 'Scarico lo storico…' : 'Storico non ancora scaricato: serve la rete';
  const quando = new Date(S.storico.preso || Date.now()).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  return `${indiceStorico().ordini.size} ordini degli ultimi 3 anni · aggiornato il ${esc(quando)} · <button type="button" class="link" data-storico>Aggiorna</button>`;
}

async function mostraClienti(forza = false) {
  disegnaClienti();
  await caricaStorico(forza);
  disegnaClienti();
}

function disegnaClienti() {
  $('#storico-info').innerHTML = infoStorico();
  const box = $('#clienti-contenuto');
  if (!S.storico) { box.innerHTML = ''; return; }
  if (S.clienteScelto) { box.innerHTML = schedaCliente(S.clienteScelto); return; }
  const idx = indiceStorico();
  const q = $('#cerca-cliente').value;
  if (q.trim()) {
    const nomi = new Map();
    for (const c of S.dati?.clienti || []) nomi.set(norm(c.nome).trim(), c.nome);
    for (const [k, c] of idx.perCliente) if (!nomi.has(k)) nomi.set(k, c.nome);
    const trovati = cerca([...nomi.values()], q, (n) => n, 40);
    box.innerHTML = trovati.length
      ? '<ul class="elenco">' + trovati.map((n) => {
          const st = idx.perCliente.get(norm(n).trim());
          const det = st ? `Ultimo ordine ${fmtData(st.ordini[0].data)} · ${st.ordini.length} ordini` : 'Nessun ordine negli ultimi 3 anni';
          return `<li class="tocca" data-cliente="${esc(n)}"><b>${esc(n)}</b><div class="det">${esc(det)}</div></li>`;
        }).join('') + '</ul>'
      : '<p class="vuoto-lista">Nessun cliente con queste parole</p>';
    return;
  }
  // Da richiamare: è passato più tempo del solito dall'ultimo ordine
  const lista = [];
  for (const c of idx.perCliente.values()) {
    const f = frequenza(vendite(c.ordini).map((o) => o.data));
    if (f && f.scaduto && f.da >= 14) lista.push({ c, f, proporre: prodottiCliente(c.ordini).filter((p) => p.f.scaduto).length });
  }
  lista.sort((a, b) => b.f.ritardo - a.f.ritardo);
  box.innerHTML = '<div class="sezione">Da richiamare</div>' + (lista.length
    ? '<ul class="elenco">' + lista.slice(0, 40).map(({ c, f, proporre }) => `<li class="tocca" data-cliente="${esc(c.nome)}">
        <div class="testa"><b>${esc(c.nome)}</b><span class="num">${quandoFa(f.da)}</span></div>
        <div class="det">Di solito ordina ogni ${f.ogni} giorni · ultimo ${fmtData(f.ultimo)}${proporre ? ` · ${proporre} prodotti da proporre` : ''}</div>
      </li>`).join('') + '</ul>'
    : '<p class="vuoto-lista">Nessun cliente in ritardo rispetto al solito</p>');
}

// Prodotti comprati dal cliente, con ogni quanto li prende
function prodottiCliente(ordini) {
  const m = new Map();
  for (const o of vendite(ordini)) {
    for (const r of o.righe) {
      const k = o.azienda + '|' + (r.cod || norm(r.nome));
      if (!m.has(k)) m.set(k, { azienda: o.azienda, cod: r.cod, nome: r.nome, date: [], pz: 0 });
      const p = m.get(k);
      p.date.push(o.data);
      p.pz += r.pz;
    }
  }
  return [...m.values()].map((p) => ({ ...p, f: frequenza(p.date) }));
}

function schedaCliente(nome) {
  const idx = indiceStorico();
  const st = idx.perCliente.get(norm(nome).trim()) || { nome, ordini: [] };
  const c = S.dati?.clienti.find((x) => stessoNome(x.nome, nome));
  const ven = vendite(st.ordini);
  const f = frequenza(ven.map((o) => o.data));
  const h = [];

  // Testata con contatti
  const luogo = c ? [c.indirizzo, [c.cap, c.citta, c.prov && `(${c.prov})`].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const contatti = [];
  if (c?.tel) contatti.push(`<a href="tel:${esc(c.tel.replace(/[^\d+]/g, ''))}">📞 ${esc(c.tel)}</a>`);
  if (c?.cell) contatti.push(`<a href="tel:${esc(c.cell.replace(/[^\d+]/g, ''))}">📱 ${esc(c.cell)}</a>`);
  if (c?.mail) contatti.push(`<a href="mailto:${esc(c.mail)}">✉ ${esc(c.mail)}</a>`);
  let ritmo = 'Nessun ordine negli ultimi 3 anni';
  if (f) ritmo = `Ultimo ordine ${fmtData(f.ultimo)} (${quandoFa(f.da)})` + (f.ogni ? ` · di solito ogni ${f.ogni} giorni` : '');
  h.push(`<button type="button" class="indietro" data-indietro>‹ Tutti i clienti</button>
    <div class="card scheda-cliente">
      <h2>${esc(st.nome || nome)}</h2>
      ${luogo ? `<div class="info">${esc(luogo)}${c?.referente ? ' · ' + esc(c.referente) : ''}</div>` : ''}
      ${contatti.length ? `<div class="contatti">${contatti.join('')}</div>` : ''}
      <div class="info">${esc(ritmo)} ${f?.scaduto ? '<span class="tag proporre">Da richiamare</span>' : ''}</div>
      <div class="azioni"><button type="button" class="primario" data-nuovo-per="${esc(c ? c.nome : nome)}">Nuovo ordine</button></div>
    </div>`);

  if (!st.ordini.length) return h.join('');

  // Venduto per azienda
  const anno = new Date(); anno.setFullYear(anno.getFullYear() - 1);
  const daAnno = new Date(anno - anno.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const perAz = new Map();
  for (const o of st.ordini) {
    if (!perAz.has(o.azienda)) perAz.set(o.azienda, { n: 0, anno: 0, tutto: 0, ultimo: '' });
    const a = perAz.get(o.azienda);
    if (o.origine !== 'reso') a.n++;
    a.tutto += o.totale || 0;
    if (o.data >= daAnno) a.anno += o.totale || 0;
    if (o.data > a.ultimo) a.ultimo = o.data;
  }
  const az = [...perAz.entries()].sort((x, y) => y[1].tutto - x[1].tutto);
  h.push(`<div class="sezione">Venduto per azienda</div><div class="card"><table class="tabella">
    <thead><tr><th>Azienda</th><th class="num">Ordini</th><th class="num">12 mesi</th><th class="num">3 anni</th></tr></thead>
    <tbody>${az.map(([n, a]) => `<tr><td>${esc(n)}<div class="info">ultimo ${fmtData(a.ultimo)}</div></td><td class="num">${a.n}</td><td class="num">${fmtEuro(a.anno)}</td><td class="num">${fmtEuro(a.tutto)}</td></tr>`).join('')}</tbody>
  </table></div>`);

  // Prodotti: ogni quanto li compra, e quali proporre adesso
  const prodotti = prodottiCliente(st.ordini);
  const note = (S.dati?.noteClienti || []).filter((n) => stessoNome(n[0], nome));
  const gruppi = new Map();
  for (const p of prodotti) {
    if (!gruppi.has(p.azienda)) gruppi.set(p.azienda, []);
    gruppi.get(p.azienda).push(p);
  }
  h.push('<div class="sezione">Prodotti comprati</div>');
  for (const [nomeAz, lista] of [...gruppi.entries()].sort((x, y) => y[1].length - x[1].length)) {
    lista.sort((a, b) => (b.f.scaduto - a.f.scaduto) || (b.f.volte - a.f.volte) || a.nome.localeCompare(b.nome, 'it'));
    const proporre = lista.filter((p) => p.f.scaduto).length;
    h.push(`<details class="gruppo"${proporre ? ' open' : ''}><summary><span>${esc(nomeAz)}</span><small>${lista.length} prodotti${proporre ? ` · ${proporre} da proporre` : ''}</small></summary>
      ${lista.map((p) => {
        const nf = note.find((n) => stessoNome(n[1], nomeAz) && stessoArticolo(n, p));
        const det = [`${p.f.volte} ${p.f.volte === 1 ? 'volta' : 'volte'}`, p.f.ogni ? `ogni ~${p.f.ogni} gg` : '', `ultimo ${fmtData(p.f.ultimo)} (${quandoFa(p.f.da)})`, `${fmtNum(p.pz)} pz in tutto`].filter(Boolean).join(' · ');
        return `<div class="prodotto"><div>${esc(p.nome)} ${p.f.scaduto ? '<span class="tag proporre">Da proporre</span>' : ''}</div>
          <div class="det">${esc(det)}</div>${nf ? `<div class="riga-nota">📌 ${esc(nf[4])}</div>` : ''}</div>`;
      }).join('')}
    </details>`);
  }

  // Ordini passati, ognuno ripetibile
  h.push('<div class="sezione">Ordini</div><ul class="elenco">' + st.ordini.slice(0, 60).map((o) => {
    const azioni = [];
    if (o.pdf) azioni.push(`<a href="${esc(o.pdf)}" target="_blank" rel="noopener">PDF</a>`);
    if (o.origine !== 'reso' && trovaAzienda(o.azienda)) azioni.push(`<button type="button" class="secondario" data-ripeti-id="${esc(o.id)}">↻ Ripeti</button>`);
    const nomi = o.righe.slice(0, 3).map((r) => r.nome).join(', ') + (o.righe.length > 3 ? ` e altri ${o.righe.length - 3}` : '');
    return `<li><div class="testa"><b>${fmtData(o.data)} · ${esc(o.azienda)}</b><span class="num">${fmtEuro(o.totale)}</span></div>
      <div class="det">${o.origine === 'reso' ? '<span class="tag reso">Reso</span> ' : ''}${esc(nomi)}</div>
      ${azioni.length ? `<div class="azioni">${azioni.join('')}</div>` : ''}</li>`;
  }).join('') + '</ul>');
  return h.join('');
}

// Il modulo "Nuovo" con un altro ordine: chiede conferma se c'è un ordine non salvato
async function apriNuovo(o, righe) {
  const cor = S.ordine;
  if (cor.righe.length && !cor.salvato && !confirm("L'ordine che stai scrivendo non è salvato e verrà sostituito. Procedo?")) return false;
  S.rigaAperta = -1;
  S.ordine = o;
  if (righe) o.righe = righe(); // dopo aver scelto l'azienda: servono il suo listino e le note fisse
  await DB.set('bozza', S.ordine);
  disegnaOrdine();
  mostraVista('nuovo');
  window.scrollTo(0, 0);
  return true;
}

function ordinePer(nomeCliente, azienda) {
  const o = nuovoOrdine();
  const c = trovaCliente(nomeCliente);
  o.cliente = c ? c.nome : nomeCliente;
  if (c && (S.dati?.pagamenti || []).some((p) => p.nome === c.pagamento)) o.pagamento = c.pagamento;
  if (azienda) {
    o.azienda = azienda;
    const az = trovaAzienda(azienda);
    if (az && typeof az.scontoMerce === 'number') o.scontoExtra = fmtNum(Math.abs(az.scontoMerce * 100));
  }
  return o;
}

async function ripetiStorico(id) {
  const vecchio = indiceStorico().ordini.get(id);
  if (!vecchio) return;
  if (!trovaAzienda(vecchio.azienda)) return avviso(`${vecchio.azienda} non è tra le aziende dell'app`, true);
  let esito;
  const ok = await apriNuovo(ordinePer(vecchio.cliente, vecchio.azienda), () => { esito = righeDaRipetere(vecchio.righe); return esito.righe; });
  if (!ok) return;
  let msg = `Caricati ${esito.righe.length} articoli dall'ordine del ${fmtData(vecchio.data)}, con i prezzi di listino attuali`;
  if (esito.fuori) msg += `. ${esito.fuori} non più in listino: tenuto il prezzo vecchio`;
  avviso(msg);
}

async function gestisciClienti(e) {
  const t = e.target.closest('[data-cliente],[data-ripeti-id],[data-indietro],[data-nuovo-per],[data-storico]');
  if (!t) return;
  const d = t.dataset;
  if (d.storico !== undefined) {
    if (!navigator.onLine) return avviso('Serve la rete per aggiornare lo storico', true);
    await caricaStorico(true);
    disegnaClienti();
    disegnaVendite();
  } else if (d.cliente) {
    S.clienteScelto = d.cliente;
    if (!$('#vista-clienti').hidden) disegnaClienti(); else mostraVista('clienti');
    window.scrollTo(0, 0);
  } else if (d.indietro !== undefined) {
    S.clienteScelto = '';
    disegnaClienti();
  } else if (d.nuovoPer) {
    if (await apriNuovo(ordinePer(d.nuovoPer))) avviso(`Nuovo ordine per ${d.nuovoPer}: scegli l'azienda`);
  } else if (d.ripetiId) {
    ripetiStorico(d.ripetiId);
  }
}

// ---------------------------------------------------------------- vendite e provvigioni

function intervallo(v) {
  const oggi = new Date(), y = oggi.getFullYear(), m = oggi.getMonth();
  const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (v === 'mese-1') return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  if (v === 'anno') return [`${y}-01-01`, `${y}-12-31`];
  if (v === 'anno-1') return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  if (v === '12m') return [iso(new Date(y - 1, m, oggi.getDate() + 1)), iso(oggi)];
  return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
}

const provvigione = (azienda) => {
  const p = S.dati?.provvigioni || {};
  const k = Object.keys(p).find((n) => stessoNome(n, azienda));
  return k ? p[k] : 0;
};

async function mostraVendite(forza = false) {
  disegnaVendite();
  await caricaStorico(forza);
  disegnaVendite();
}

function disegnaVendite() {
  const box = $('#vendite-contenuto');
  const info = `<div class="info">${infoStorico()}</div>`;
  if (!S.storico) { box.innerHTML = info; return; }
  const [da, a] = intervallo($('#periodo').value);
  const sel = [...indiceStorico().ordini.values()].filter((o) => o.data >= da && o.data <= a);
  const perAz = new Map(), perCli = new Map();
  for (const o of sel) {
    if (!perAz.has(o.azienda)) perAz.set(o.azienda, { n: 0, tot: 0 });
    const x = perAz.get(o.azienda);
    if (o.origine !== 'reso') x.n++;
    x.tot += o.totale || 0;
    perCli.set(o.cliente, (perCli.get(o.cliente) || 0) + (o.totale || 0));
  }
  const righe = [...perAz.entries()].map(([az, x]) => ({ az, ...x, pp: provvigione(az) })).sort((p, q) => q.tot - p.tot);
  const tot = righe.reduce((s, r) => s + r.tot, 0);
  const totProv = righe.reduce((s, r) => s + r.tot * r.pp, 0);
  const nOrd = righe.reduce((s, r) => s + r.n, 0);
  const h = [`<div class="card"><div class="info">Dal ${fmtData(da)} al ${fmtData(a)} · totali degli ordini, resi sottratti</div>`];
  if (!righe.length) {
    h.push('<p class="vuoto-lista">Nessun ordine nel periodo</p></div>');
  } else {
    h.push(`<table class="tabella"><thead><tr><th>Azienda</th><th class="num">Ordini</th><th class="num">Venduto</th><th class="num">Provvigione</th></tr></thead>
      <tbody>${righe.map((r) => `<tr><td>${esc(r.az)}</td><td class="num">${r.n}</td><td class="num">${fmtEuro(r.tot)}</td>
        <td class="num">${r.pp ? `${fmtEuro(r.tot * r.pp)}<div class="info">${pct(r.pp)}</div>` : '—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Totale</td><td class="num">${nOrd}</td><td class="num">${fmtEuro(tot)}</td><td class="num">${fmtEuro(totProv)}</td></tr></tfoot>
    </table>`);
    if (!Object.keys(S.dati?.provvigioni || {}).length) {
      h.push('<span class="nota">Per vedere le provvigioni scrivi le percentuali nel file Ordini Dati, scheda Provvigioni, poi premi "Aggiorna clienti e listini" nelle impostazioni</span>');
    }
    h.push('</div>');
    const top = [...perCli.entries()].sort((p, q) => q[1] - p[1]).slice(0, 10);
    h.push('<div class="sezione">Clienti migliori del periodo</div><ul class="elenco">' + top.map(([n, v]) =>
      `<li class="tocca" data-cliente="${esc(n)}"><div class="testa"><b>${esc(n)}</b><span class="num">${fmtEuro(v)}</span></div></li>`).join('') + '</ul>');
  }
  h.push(info);
  box.innerHTML = h.join('');
}

// ---------------------------------------------------------------- navigazione

function mostraVista(nome) {
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.id !== 'vista-' + nome; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('attivo', b.dataset.vista === nome));
  if (nome === 'coda') sincronizza();
  if (nome === 'clienti') mostraClienti();
  if (nome === 'vendite') mostraVendite();
}

// ---------------------------------------------------------------- avvio

async function avvio() {
  S.imp = (await DB.get('impostazioni')) || S.imp;
  S.dati = (await DB.get('dati')) || null;
  S.ordine = (await DB.get('bozza')) || nuovoOrdine();

  // ?demo apre l'app con dati di prova
  if (new URLSearchParams(location.search).has('demo') && !S.imp.url) {
    S.imp = { url: DEMO, token: '' };
    await DB.set('impostazioni', S.imp);
  }

  $('#imp-url').value = S.imp.url;
  $('#imp-token').value = S.imp.token;

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => mostraVista(b.dataset.vista)));

  collegaRicerca('#cliente-input', '#cliente-lista', () => S.dati?.clienti || [], (c) => c.nome,
    (c) => [c.citta, c.prov].filter(Boolean).join(' '), sceltaCliente);
  collegaRicerca('#azienda-input', '#azienda-lista', () => S.dati?.aziende || [], (a) => a.nome,
    (a) => `${(S.dati.listini[a.nome] || []).length} prodotti`, sceltaAzienda);

  $('#pagamento').addEventListener('change', (e) => { S.ordine.pagamento = e.target.value; aggiornaTotali(); salvaBozza(); });
  $('#data').addEventListener('change', (e) => { S.ordine.data = e.target.value || oggiIso(); salvaBozza(); });
  // Consegna: "Pronta Consegna" oppure una data scelta dal calendario (scritta come gg/mm/aaaa)
  $('#consegna-data').addEventListener('click', (e) => { try { e.target.showPicker(); } catch (err) { /* il telefono apre da solo */ } });
  $('#consegna-data').addEventListener('change', (e) => {
    const v = e.target.value;
    S.ordine.consegna = v ? v.split('-').reverse().join('/') : CONSEGNA_PRONTA;
    mostraConsegna(); salvaBozza();
  });
  $('#consegna-pronta').addEventListener('click', () => { S.ordine.consegna = CONSEGNA_PRONTA; mostraConsegna(); salvaBozza(); });
  $('#note').addEventListener('input', (e) => { S.ordine.note = e.target.value; salvaBozza(); });
  $('#sconto-extra').addEventListener('input', (e) => { S.ordine.scontoExtra = e.target.value; aggiornaTotali(); salvaBozza(); });
  $('#bozza-azienda').addEventListener('change', (e) => { S.ordine.bozze.azienda = e.target.checked; disegnaAvvisoEmail(); salvaBozza(); });
  $('#bozza-cliente').addEventListener('change', (e) => { S.ordine.bozze.cliente = e.target.checked; disegnaAvvisoEmail(); salvaBozza(); });
  $('#btn-nuovo-cliente').addEventListener('click', apriNuovoCliente);
  $('#form-cliente').addEventListener('submit', salvaNuovoCliente);
  $('#nc-annulla').addEventListener('click', () => $('#dlg-cliente').close());
  $('#cerca-ordini').addEventListener('input', () => disegnaCoda());
  $('#cerca-cliente').addEventListener('input', () => { S.clienteScelto = ''; disegnaClienti(); });
  $('#clienti-contenuto').addEventListener('click', gestisciClienti);
  $('#storico-info').addEventListener('click', gestisciClienti);
  $('#vendite-contenuto').addEventListener('click', gestisciClienti);
  $('#periodo').addEventListener('change', disegnaVendite);

  $('#prodotto-input').addEventListener('input', cercaProdotti);
  $('#btn-ripeti').addEventListener('click', ripetiUltimo);
  $('#prodotto-lista').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) aggiungiProdotto($('#prodotto-lista')._trovati[li.dataset.i]);
  });
  $('#righe').addEventListener('click', gestisciRighe);
  $('#righe').addEventListener('input', modificaRiga);
  $('#righe').addEventListener('change', (e) => { if (e.target.type === 'checkbox') modificaRiga(e); });
  $('#righe').addEventListener('focusin', (e) => { if (e.target.matches('input')) e.target.select(); });

  $('#btn-salva').addEventListener('click', () => salvaOrdine(false));
  $('#btn-invia').addEventListener('click', () => salvaOrdine(true));
  $('#btn-svuota').addEventListener('click', async () => {
    const domanda = S.ordine.salvato
      ? 'Chiudo questo ordine? Le modifiche non salvate si perdono (la versione salvata resta in Ordini).'
      : "Svuoto l'ordine in corso?";
    if ((S.ordine.salvato || S.ordine.righe.length) && !confirm(domanda)) return;
    S.ordine = nuovoOrdine();
    await DB.set('bozza', S.ordine);
    disegnaOrdine();
  });

  $('#btn-sync').addEventListener('click', () => {
    if (!navigator.onLine) return avviso('Sei offline: gli ordini partiranno appena torna la rete', true);
    sincronizza(true);
  });
  $('#lista-ordini').addEventListener('click', gestisciCoda);

  $('#btn-salva-imp').addEventListener('click', async () => {
    S.imp = { url: $('#imp-url').value.trim(), token: $('#imp-token').value.trim() };
    await DB.set('impostazioni', S.imp);
    avviso('Impostazioni salvate');
    if (!S.dati) aggiornaDati();
  });
  $('#btn-prova').addEventListener('click', async () => {
    const vecchie = S.imp;
    S.imp = { url: $('#imp-url').value.trim(), token: $('#imp-token').value.trim() };
    try { await api('ping'); avviso('Collegamento riuscito'); } catch (err) { avviso(err.message, true); }
    S.imp = vecchie;
  });
  $('#btn-aggiorna').addEventListener('click', () => aggiornaDati());

  window.addEventListener('online', () => sincronizza());
  window.addEventListener('offline', () => disegnaCoda());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizza(); });

  // Un ordine rimasto "Invio…" per chiusura dell'app torna in coda (il server non lo duplica)
  for (const o of await DB.ordini()) {
    if (o.stato === 'invio') { o.stato = 'attesa'; await DB.salvaOrdine(o); }
    // Ordini di prima della sincronizzazione: da copiare sul foglio
    if (!o.aggiornato) { o.aggiornato = o.creato; o.sporco = true; await DB.salvaOrdine(o); }
  }

  disegnaOrdine();
  disegnaInfoDati();
  await sincronizza();

  if (!S.imp.url) {
    mostraVista('impostazioni');
  } else if (!S.dati || Date.now() - new Date(S.dati.aggiornato) > 12 * 3600 * 1000) {
    aggiornaDati(!!S.dati);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

avvio();
