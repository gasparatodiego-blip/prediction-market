#!/usr/bin/env node
'use strict';
// .claude/hooks/blocca-piazzamento.js — IL BLOCCO STRUTTURALE DEL PIAZZAMENTO REALE.
//
// ═══ PERCHÉ ESISTE, VISTO CHE C'È GIÀ LA POLICY DEI PERMESSI ════════════════════════════════════════
// Le regole `ask` di .claude/settings.json guardano la STRINGA del comando: se il comando nomina una
// rotta di piazzamento, chiedono. È una buona prima linea e resta al suo posto, ma ha un limite che il
// file stesso dichiara — copre le forme note. `node /tmp/x.js`, dove x.js importa `placeManualOrder`,
// non nomina niente: nessuna regola lo vede, e il capitale è reale.
//
// Questo hook chiude quel buco perché non si ferma alla stringa: quando il comando ESEGUE un file, apre
// il file e ne cammina il grafo dei `require`/`import` fino a una profondità utile, cercando le funzioni
// che piazzano davvero. È lo stesso metodo con cui il test del guardiano dimostra che quel processo è
// strutturalmente incapace di piazzare — applicato all'incontrario.
//
// ═══ LA SUPERFICIE DI PIAZZAMENTO VERA, letta dal codice ════════════════════════════════════════════
//   · lib/venues/polymarket-clob-maker/adapter.js  → postOrder    (l'UNICA POST /order del progetto)
//   · lib/maker/manual-order.js                    → placeManualOrder / replaceManualOrder
//   · lib/maker/bulk-allocate.js                   → runBulkAllocation (la corsia di agent41)
//   · le rotte /api/maker/manual/{order,replace,bulk-allocate}
//   · gli script e gli agent che li usano: agent35-maker, agent40-manual-reprice, maker-live-test-order
//   · gli env che ARMANO il piazzamento: MAKER_PLACEMENT=send, MANUAL_ORDER_PLACEMENT=send,
//     MAKER_MODE=live|on
// La firma EIP-712 (`signTypedData`) è nell'elenco perché firmare un ordine è l'atto irreversibile:
// dopo la firma il resto è trasporto.
//
// ═══ COSA NON TOCCA ═════════════════════════════════════════════════════════════════════════════════
// git, pm2, npm, build, edit, cat, grep, i test. Il criterio non è «il comando è pericoloso» ma «questo
// comando porta a un ordine reale». Un `git commit` che tocca manual-order.js non piazza niente, e
// bloccarlo insegnerebbe soltanto a disattivare l'hook.
//
// ═══ CANCELLARE NON È PIAZZARE ══════════════════════════════════════════════════════════════════════
// `cancelOrder`, `cancelMarketOrders`, `cancel-all` NON sono in elenco. Cancellare può solo ridurre
// l'esposizione, ed è l'azione che il guardiano delle perdite deve poter fare senza chiedere.
//
// Contratto: PreToolUse riceve il JSON su stdin e risponde su stdout con
// hookSpecificOutput.permissionDecision. In caso di dubbio su un file illeggibile si LASCIA PASSARE e
// lo si dice: questo hook è la seconda linea, non l'unica, e un blocco su tutto ciò che non si riesce a
// leggere renderebbe il progetto inutilizzabile — che è il modo più rapido per farlo disattivare.

const fs = require('fs');
const path = require('path');

const RADICE = '/root/rewards-bot';

// ── I SEGNALI. Nome → perché quel nome significa «ordine reale». ───────────────────────────────────
const SEGNALI = [
  [/\bpostOrder\b/, 'postOrder — l\'unica POST /order del progetto'],
  [/\bplaceManualOrder\b/, 'placeManualOrder — l\'imbuto di piazzamento del pannello, di bulk-allocate e di agent41'],
  [/\breplaceManualOrder\b/, 'replaceManualOrder — cancella e ripiazza: la seconda metà è un piazzamento'],
  [/\brunBulkAllocation\b/, 'runBulkAllocation — la corsia con cui agent41 piazza il piano'],
  [/\bcreateOrder\b/, 'createOrder — costruisce e firma l\'ordine'],
  [/signTypedData|_signTypedData/, 'firma EIP-712 di un ordine — dopo la firma il resto è solo trasporto'],
  [/\/api\/maker\/manual\/order/, 'rotta di piazzamento manuale'],
  [/\/api\/maker\/manual\/replace/, 'rotta di riprezzo manuale (cancella e ripiazza)'],
  [/\/api\/maker\/manual\/bulk-allocate/, 'rotta di allocazione in blocco'],
  [/maker-live-test-order/, 'script di ordine reale di prova'],
  [/maker-dryrun-place/, 'script di piazzamento'],
  [/agent35-maker/, 'il motore maker: gira con MAKER_PLACEMENT=send'],
  [/agent40-manual-reprice/, 'il watcher che riprezza gli ordini a mano'],
  [/agent41-realloc-scheduler/, 'il riallocatore: è l\'unico processo che piazza da solo'],
  [/MAKER_PLACEMENT\s*=\s*send/, 'MAKER_PLACEMENT=send arma il piazzamento del motore'],
  [/MANUAL_ORDER_PLACEMENT\s*=\s*send/, 'MANUAL_ORDER_PLACEMENT=send arma il piazzamento manuale'],
  [/MAKER_MODE\s*=\s*(live|on)\b/, 'MAKER_MODE live/on arma il motore'],
];

// ── I COMANDI DI TUTTI I GIORNI ────────────────────────────────────────────────────────────────────
// Un hook che blocca troppo viene disattivato, e allora non protegge più niente. Questi non piazzano
// per costruzione — sono letture, git, build, pm2 in lettura.
//
// SI VALUTA SEGMENTO PER SEGMENTO, e non è un dettaglio: `cat x | curl -X POST .../manual/order`
// comincia con `cat`, e una regola ancorata all'inizio del comando lo lascerebbe passare. Ogni pezzo
// separato da `;`, `&&`, `||` o `|` deve essere innocuo perché lo sia il comando.
const INNOCUI = [
  /^git(\s|$)/, /^npm\s+(run\s+)?(build|lint|test|ci|install)\b/, /^pm2\s+(list|jlist|logs|describe|env|show|status)\b/,
  /^(cat|head|tail|less|wc|ls|find|grep|rg|stat|du|df|file|realpath|readlink|basename|dirname|sort|uniq|tr|cut|sed|awk|diff|comm)\b/,
  /^(echo|printf|true|false|date|pwd|whoami|uname|which|env|sleep|mkdir|test|\[)\b/,
  /^jq\b/, /^tee\b/,
  /^curl\s+[^|;&]*https?:\/\/localhost:3000\/api\/(health|rewards|maker\/(board|status|positions|markets|live-mid|gates|universe))/,
];

const segmenti = (cmd) => cmd.split(/\|\||&&|[;|]/).map((s) => s.trim()).filter(Boolean);
const tuttoInnocuo = (cmd) => {
  const parti = segmenti(cmd);
  return parti.length > 0 && parti.every((p) => INNOCUI.some((re) => re.test(p.replace(/^\(\s*/, ''))));
};

/**
 * IL CORPO DI UN HEREDOC È UN DATO, NON UNA RIGA DI COMANDO — e questo hook l'ha imparato bloccando
 * il proprio commit.
 *
 * `git commit -F - <<'EOF' … EOF` con un messaggio che spiega quali funzioni piazzano contiene, per
 * forza, i nomi di quelle funzioni; e se il messaggio contiene anche un `|` (per dire, `MAKER_MODE=
 * live|on`) la segmentazione lo spezza, il pezzo di prosa non somiglia a nessun comando innocuo, e il
 * controllo sulla stringa trova `postOrder` dentro una frase che parla di postOrder. Descrivere il
 * piazzamento non è piazzare.
 *
 * Quindi: il corpo si toglie PRIMA di segmentare, e se quel che resta è innocuo (git, tee, cat) il
 * comando è innocuo. Se invece quel che resta NON è innocuo — `node <<'EOF' … EOF`, che esegue davvero
 * il corpo — il testo torna dentro l'analisi e viene giudicato per intero.
 */
function senzaHeredoc(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2\s*$/gm, '<<HEREDOC');
}

/**
 * I TEST DEL REPO SI ESEGUONO, E NON PIAZZANO — un'esenzione dichiarata, non un buco dimenticato.
 *
 * Un file `*.test.js` di questo progetto nomina di continuo le funzioni di piazzamento: è il suo
 * mestiere provare che rifiutano. `lib/safety/policy-permessi.test.js` contiene per esteso
 * `MAKER_MODE=live node agents/agent35-maker.js` dentro il proprio corpus. Se l'hook leggesse quei
 * file come intenzioni, ogni giro di test verrebbe bloccato — e un hook che impedisce di lavorare
 * viene spento entro il giorno.
 *
 * L'esenzione vale SOLO per il contenuto del file: se il comando che lo lancia arma il piazzamento
 * (`MAKER_PLACEMENT=send node x.test.js`), il segnale sulla stringa scatta comunque, perché quello
 * l'ha scritto chi lancia, non chi ha scritto il test.
 */
const eUnTest = (file) => /\.test\.(js|ts|mjs|cjs)$/.test(file) && file.startsWith(RADICE);

const CODICE = (t) => String(t).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function decidi(comando) {
  const cmd = String(comando || '');
  if (!cmd.trim()) return null;

  // 0 · LE LETTURE, PRIMA DI TUTTO. `grep -rn "placeManualOrder" lib/` NOMINA il piazzamento e non ne
  //     fa nessuno: se il controllo sulla stringa venisse prima, cercare il difetto sarebbe vietato.
  //     Il corpo di un heredoc si toglie prima di segmentare — vedi senzaHeredoc: un messaggio di
  //     commit che SPIEGA il piazzamento non è un piazzamento.
  if (tuttoInnocuo(senzaHeredoc(cmd))) return null;

  // 1 · LA STRINGA. Un comando che nomina il piazzamento è già deciso.
  for (const [re, perche] of SEGNALI) {
    if (re.test(cmd)) return { dove: 'nel comando stesso', perche, prova: (cmd.match(re) || [''])[0] };
  }

  // 2 · GLI SCRIPT INTERMEDI. `node x.js`, `./x.sh`, `bash x.sh`: si apre il file e si guarda dentro,
  //     poi si seguono i suoi require locali. È il caso che nessuna regola sulla stringa può vedere.
  const file = fileEseguito(cmd);
  if (file && !eUnTest(file)) {
    const trovato = camminaFile(file, 0, new Set());
    if (trovato) return trovato;
  }

  // 3 · IL CODICE INLINE. `node -e "..."`, `node --eval`, `python -c`: il corpo è nel comando, ma può
  //     essere costruito a pezzi (`const f='place'+'ManualOrder'`), quindi si guarda anche il grezzo.
  const inline = cmd.match(/-{1,2}(?:e|eval|c)\s+(['"])([\s\S]*?)\1/);
  if (inline) {
    for (const [re, perche] of SEGNALI) {
      if (re.test(inline[2])) return { dove: 'nel codice inline', perche, prova: (inline[2].match(re) || [''])[0] };
    }
    // Un require verso i moduli che piazzano, anche senza nominare la funzione.
    const m = inline[2].match(/require\(['"]([^'"]+)['"]\)/g) || [];
    for (const r of m) {
      const p = (r.match(/['"]([^'"]+)['"]/) || [])[1] || '';
      if (/manual-order|bulk-allocate|polymarket-clob-maker\/adapter/.test(p)) {
        return { dove: 'nel codice inline', perche: `require di ${p}, che è un modulo di piazzamento`, prova: p };
      }
    }
  }

  return null;
}

/** Il file che questo comando ESEGUE, se ce n'è uno leggibile sotto la radice del progetto. */
function fileEseguito(cmd) {
  const m = cmd.match(/(?:^|[;&|]\s*)(?:\S*\/)?(?:node|bash|sh|python3?|npx\s+tsx?|\.\/)\s*([^\s;&|]+\.(?:js|mjs|cjs|ts|sh|py))/);
  const grezzo = m ? m[1] : (cmd.match(/(?:^|\s)(\.\/[^\s;&|]+)/) || [])[1];
  if (!grezzo) return null;
  const p = path.isAbsolute(grezzo) ? grezzo : path.resolve(RADICE, grezzo);
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

/** Il grafo dei require, in profondità limitata: la catena vera è corta, e un limite evita i cicli. */
function camminaFile(file, prof, visti) {
  if (prof > 3 || visti.has(file) || visti.size > 60) return null;
  visti.add(file);
  let src;
  try { src = CODICE(fs.readFileSync(file, 'utf8')); } catch { return null; }

  for (const [re, perche] of SEGNALI) {
    if (re.test(src)) {
      return { dove: `dentro ${path.relative(RADICE, file)}${prof ? ` (raggiunto in ${prof} require)` : ''}`, perche, prova: (src.match(re) || [''])[0] };
    }
  }

  const rif = [...src.matchAll(/(?:require\(|from\s+)['"]([^'"]+)['"]/g)].map((x) => x[1]);
  for (const r of rif) {
    if (!r.startsWith('.') && !r.startsWith('/') && !r.startsWith('@/')) continue;   // niente node_modules
    const base = r.startsWith('@/') ? path.join(RADICE, r.slice(2)) : path.resolve(path.dirname(file), r);
    for (const cand of [base, base + '.js', base + '.ts', path.join(base, 'index.js')]) {
      try {
        if (!fs.statSync(cand).isFile()) continue;
      } catch { continue; }
      const t = camminaFile(cand, prof + 1, visti);
      if (t) return t;
      break;
    }
  }
  return null;
}

function main() {
  let grezzo = '';
  try { grezzo = fs.readFileSync(0, 'utf8'); } catch { /* niente stdin */ }
  let dati = {};
  try { dati = JSON.parse(grezzo || '{}'); } catch { dati = {}; }

  if (dati.tool_name !== 'Bash') return esci(null);
  const comando = dati.tool_input && dati.tool_input.command;

  let esito = null;
  try { esito = decidi(comando); }
  catch { esito = null; }   // un'analisi che esplode non deve bloccare il lavoro: seconda linea, non unica
  esci(esito);
}

function esci(esito) {
  if (!esito) { process.stdout.write(JSON.stringify({ suppressOutput: true })); process.exit(0); }
  const motivo =
    `PIAZZAMENTO REALE BLOCCATO.\n\n`
    + `Trovato ${esito.dove}: ${esito.perche}.\n`
    + `Il segnale letto è «${String(esito.prova).slice(0, 80)}».\n\n`
    + `Questo comando porta a un ordine con capitale reale, e la regola 3 di CLAUDE.md §2 dice che si `
    + `piazza solo dopo conferma esplicita dell'utente IN CHAT, ogni volta. Le due sole eccezioni sono `
    + `agent41 (riallocazione, quando il bot è su AVVIA) e agent42-guardian (cancellazioni), e non `
    + `passano da qui.\n\n`
    + `Cosa fare: descrivi in chat cosa vuoi piazzare e aspetta il via libera dell'utente. `
    + `Non aggirare l'hook riscrivendo il comando: guarda anche dentro gli script e i loro require.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: motivo,
    },
  }));
  process.exit(0);
}

if (require.main === module) main();
module.exports = { decidi, SEGNALI };
