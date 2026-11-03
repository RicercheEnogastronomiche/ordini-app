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

  let spedizione = 0, portoTipo = '', portoTesto = '';
  if (az && az.portoFranco && o.righe.length) {
    const pf = az.portoFranco;
    portoTipo = pf.tipo;
    const raggiunto = pf.tipo === 'eur' ? somma >= pf.valore : pf.tipo === 'ct' ? totCt >= pf.valore : totPz >= pf.valore;
    spedizione = raggiunto ? 0 : (az.spedizione || 0);
    portoTesto = pf.tipo === 'eur' ? fmtEuro(pf.valore) : pf.valore + ' ' + pf.tipo;
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

  return { somma, totPz, totCt, spedizione, portoTipo, portoTesto, scontoPag, scontoPagTesto, extra, totale };
}

const pct = (v) => (v * 100).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + '%';

// ---------------------------------------------------------------- disegno vista "Nuovo"

function disegnaOrdine() {
  const o = S.ordine;
  $('#cliente-input').value = o.cliente;
  $('#azienda-input').value = o.azienda;
  $('#data').value = o.data;
  $('#consegna').value = o.consegna;
  $('#note').value = o.note;
  $('#sconto-extra').value = o.scontoExtra;
  $('#bozza-azienda').checked = !!o.bozze.azienda;
  $('#bozza-cliente').checked = !!o.bozze.cliente;
  $('#in-modifica').hidden = !o.salvato;
  disegnaPagamenti();
  disegnaInfoCliente();
  disegnaInfoAzienda();
  disegnaRighe();
}

function disegnaPagamenti() {
  const sel = $('#pagamento');
  const nomi = (S.dati?.pagamenti || []).map((p) => p.nome).filter((n) => !/^seleziona/i.test(n));
  if (S.ordine.pagamento && !nomi.includes(S.ordine.pagamento)) nomi.unshift(S.ordine.pagamento);
  sel.innerHTML = '<option value="">— scegli —</option>' + nomi.map((n) => `<option>${esc(n)}</option>`).join('');
  sel.value = S.ordine.pagamento;
}

function disegnaInfoCliente() {
  const el = $('#cliente-info');
  const nome = S.ordine.cliente;
  if (!nome) { el.innerHTML = ''; return; }
  const c = trovaCliente(nome);
  if (!c) { el.innerHTML = '<span class="nota">Cliente non in anagrafica: il PDF avrà solo il nome</span>'; return; }
  const luogo = [c.indirizzo, [c.cap, c.citta, c.prov && `(${c.prov})`].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const contatti = [c.referente, c.tel || c.cell, c.mail].filter(Boolean).join(' · ');
  el.innerHTML = [luogo, contatti].filter(Boolean).map(esc).join('<br>');
}

function disegnaInfoAzienda() {
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

function disegnaRighe() {
  const box = $('#righe');
  box.innerHTML = S.ordine.righe.map((r, i) => {
    const sotto = [r.cod, r.imballo ? `${fmtNum(r.imballo)} pz/ct` : ''].filter(Boolean).join(' · ');
    return `<div class="riga" data-i="${i}">
      <div class="riga-top">
        <div class="riga-nome">${esc(r.nome)}${sotto ? `<small>${esc(sotto)}</small>` : ''}</div>
        <button class="x" data-azione="rimuovi" aria-label="Togli articolo">×</button>
      </div>
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
  disegnaPagamenti();
  disegnaInfoCliente();
  aggiornaTotali();
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
    o.righe.push({ cod: p[0], nome: p[1], prezzo: p[2] || 0, imballo: p[3] || 0, qta: 1, unita: p[3] ? 'ct' : 'pz' });
  }
  $('#prodotto-input').value = '';
  $('#prodotto-lista').innerHTML = '';
  disegnaRighe();
  salvaBozza();
  avviso(esistente ? `${p[1]}: quantità ${fmtNum(esistente.qta)}` : `Aggiunto: ${p[1]}`);
}

function gestisciRighe(e) {
  const el = e.target.closest('.riga');
  if (!el) return;
  const r = S.ordine.righe[el.dataset.i];
  const azione = e.target.dataset.azione;
  const unita = e.target.dataset.unita;
  if (azione === 'rimuovi') {
    S.ordine.righe.splice(el.dataset.i, 1);
    disegnaRighe();
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
  const campo = e.target.dataset.campo;
  if (!el || !campo) return;
  S.ordine.righe[el.dataset.i][campo] = numIt(e.target.value);
  aggiornaTotali();
  salvaBozza();
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
      return { cod: r.cod, nome: r.nome, unita: r.unita, qta: r.qta, pz: c.pz, ct: c.ct, imballo: r.imballo, prezzo: r.prezzo, totale: c.totale };
    }),
    totali: { somma: t.somma, spedizione: t.spedizione, portoTipo: t.portoTipo, scontoPagamento: t.scontoPag, totale: t.totale },
  };
}

function erroreInvio(p) {
  if (!p.cliente) return 'Manca il cliente';
  if (!trovaAzienda(p.azienda)) return "Manca l'azienda";
  if (!p.righe.length) return 'Nessun articolo con quantità';
  return '';
}

const confermaInvio = (p) => confirm(`Invio l'ordine di ${p.cliente} (${fmtEuro(p.totali.totale)})?\nDopo l'invio non si potrà più modificare.`);

const trovaRecord = async (id) => (await DB.ordini()).find((x) => x.id === id);

// Salva l'ordine sul telefono come bozza; con invia=true lo mette in coda per il server
async function salvaOrdine(invia) {
  const o = S.ordine;
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
  await DB.salvaOrdine({ id: o.id, creato: vecchio?.creato || Date.now(), stato: invia ? 'attesa' : 'bozza', payload, ordine: modulo });
  S.ordine = nuovoOrdine();
  await DB.set('bozza', S.ordine);
  disegnaOrdine();
  window.scrollTo(0, 0);
  mostraVista('coda');
  if (invia) {
    avviso(navigator.onLine ? 'Invio in corso…' : 'Partirà appena torna la rete');
    sincronizza();
  } else {
    avviso('Salvato. Lo trovi in Ordini, da modificare o inviare');
  }
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
    await DB.salvaOrdine(rec);
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
  await DB.salvaOrdine(rec);
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
  if (S.sincronizzando || !navigator.onLine || !S.imp.url) { await disegnaCoda(); return; }
  S.sincronizzando = true;
  try {
    const lista = (await DB.ordini())
      .filter((o) => o.stato === 'attesa' || (anche_errori && o.stato === 'errore'))
      .sort((a, b) => a.creato - b.creato);
    for (const o of lista) {
      o.stato = 'invio';
      await DB.salvaOrdine(o);
      await disegnaCoda();
      try {
        o.esito = await api('ordine', { ordine: o.payload });
        o.stato = 'inviato';
        o.errore = '';
      } catch (err) {
        o.stato = err.rete ? 'attesa' : 'errore';
        o.errore = err.message;
        await DB.salvaOrdine(o);
        if (err.rete) break;
        continue;
      }
      await DB.salvaOrdine(o);
    }
  } finally {
    S.sincronizzando = false;
    await disegnaCoda();
  }
}

const ETICHETTE_STATO = { bozza: 'Da inviare', attesa: 'In attesa', invio: 'Invio…', inviato: 'Inviato', errore: 'Errore' };

async function disegnaCoda() {
  const ordini = (await DB.ordini()).sort((a, b) => b.creato - a.creato);
  const daInviare = ordini.filter((o) => o.stato !== 'inviato').length;
  const badge = $('#badge-coda');
  badge.hidden = !daInviare;
  badge.textContent = daInviare;
  disegnaRete(daInviare);

  const ul = $('#lista-ordini');
  if (!ordini.length) { ul.innerHTML = '<li class="vuoto-lista">Nessun ordine salvato</li>'; return; }
  ul.innerHTML = ordini.map((o) => {
    const p = o.payload;
    const e = o.esito || {};
    let msg = '';
    if (o.stato === 'inviato') {
      msg = [e.duplicato ? 'Era già registrato.' : `Scheda: ${e.foglio}`, ...(e.bozze || [])].join('\n');
    } else if (o.errore) {
      msg = o.errore;
    }
    const azioni = [];
    if (e.pdf) azioni.push(`<a href="${esc(e.pdf)}" target="_blank" rel="noopener">Apri PDF</a>`);
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
  const { riprova, elimina, invia, modifica } = e.target.dataset;
  if (invia) {
    inviaSalvato(invia);
  } else if (modifica) {
    modificaSalvato(modifica);
  } else if (riprova) {
    sincronizza(true);
  } else if (elimina) {
    const o = (await DB.ordini()).find((x) => x.id === elimina);
    const avvisoTesto = o && o.stato === 'inviato'
      ? "Tolgo l'ordine solo da questo telefono (resta nel foglio e su Drive). Procedo?"
      : 'Questo ordine non è ancora stato inviato: eliminandolo si perde. Procedo?';
    if (!confirm(avvisoTesto)) return;
    await DB.eliminaOrdine(elimina);
    await chiudiSeAperto(elimina);
    disegnaCoda();
  }
}

function disegnaRete(daInviare) {
  const el = $('#stato-rete');
  const online = navigator.onLine;
  el.className = 'pill' + (online ? '' : ' offline');
  el.textContent = (online ? 'Online' : 'Offline') + (daInviare ? ` · ${daInviare} da inviare` : '');
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
  if (azione === 'ordine') return { id: extra.ordine.id, foglio: `${extra.ordine.cliente} (prova)`, pdf: '', bozze: ['Modalità prova: nessuna bozza creata'] };
  return {};
}

async function aggiornaDati(silenzioso = false) {
  const btn = $('#btn-aggiorna');
  btn.disabled = true;
  btn.textContent = 'Scarico…';
  try {
    const dati = await api('dati');
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

// ---------------------------------------------------------------- navigazione

function mostraVista(nome) {
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.id !== 'vista-' + nome; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('attivo', b.dataset.vista === nome));
  if (nome === 'coda') disegnaCoda();
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
  $('#consegna').addEventListener('input', (e) => { S.ordine.consegna = e.target.value; salvaBozza(); });
  $('#note').addEventListener('input', (e) => { S.ordine.note = e.target.value; salvaBozza(); });
  $('#sconto-extra').addEventListener('input', (e) => { S.ordine.scontoExtra = e.target.value; aggiornaTotali(); salvaBozza(); });
  $('#bozza-azienda').addEventListener('change', (e) => { S.ordine.bozze.azienda = e.target.checked; salvaBozza(); });
  $('#bozza-cliente').addEventListener('change', (e) => { S.ordine.bozze.cliente = e.target.checked; salvaBozza(); });

  $('#prodotto-input').addEventListener('input', cercaProdotti);
  $('#prodotto-lista').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) aggiungiProdotto($('#prodotto-lista')._trovati[li.dataset.i]);
  });
  $('#righe').addEventListener('click', gestisciRighe);
  $('#righe').addEventListener('input', modificaRiga);
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
