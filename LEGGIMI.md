# Cave Informa

App informativa di protezione civile per Cave (RM), a cura dell'Associazione Italiana Protezione Civile Cave – OdV. Installabile su iPhone e Android senza App Store. (Fino alla versione 2.8 si chiamava "Allerta Cave".)

## Contenuto

- `index.html`: l'app
- `manifest.webmanifest`: nome, icona e colori per l'installazione
- `sw.js`: funzionamento senza internet
- `icons/`: icone dell'app

## Pubblicazione gratuita con GitHub Pages

1. Crea un account gratuito su github.com.
2. Crea un nuovo repository pubblico, per esempio `allerta-cave`.
3. Clicca "Add file" → "Upload files" e carica tutti i file di questa cartella, compresa la cartella `icons`. Conferma con "Commit changes".
4. Vai in Settings → Pages. In "Branch" scegli `main` e la cartella `/ (root)`, poi Save.
5. Dopo un minuto l'app sarà online a un indirizzo tipo `https://tuonome.github.io/Cave-Informa/`.

L'indirizzo deve essere https, altrimenti installazione e modalità offline non funzionano. GitHub Pages lo fa già da solo.

## Installazione

- **iPhone**: apri l'indirizzo in Safari, tocca Condividi e poi "Aggiungi alla schermata Home".
- **Android**: apri l'indirizzo in Chrome e tocca "Installa app" (oppure menu ⋮ → "Aggiungi a schermata Home").

Dopo la prima apertura, guide, zaino e numeri funzionano anche senza connessione.

## Aggiornare l'app

1. Modifica i file e ricaricali su GitHub.
2. Aumenta il numero di versione (2.0 → 2.1 → 2.2…) in `sw.js` e nella riga "Versione" di `index.html`.

Così i telefoni scaricano la nuova versione alla prossima apertura con internet.

## Allerta di oggi

La prima pagina mostra il livello di allerta di oggi e di domani per Cave, per la posizione del telefono o per un altro comune scelto dall'utente. I dati vengono dal bollettino nazionale di criticità del Dipartimento della Protezione Civile, pubblicato come dato aperto (CC BY 4.0) su github.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica.

- L'app cerca un nuovo bollettino al massimo ogni 20 minuti e salva l'ultimo scaricato, così funziona anche senza connessione.
- La posizione viene usata solo sul telefono per trovare la zona di allerta e non viene inviata a nessuno.

## Defibrillatori (DAE): aggiornamento automatico

- `dae.json`: elenco dei DAE letto dall'app. Non va modificato a mano.
- `scripts/aggiorna-dae.mjs` e `.github/workflows/dae.yml`: ogni ora GitHub Actions legge la mappa pubblica dei DAE della Croce Rossa e, se è cambiata, aggiorna `dae.json`.
- Protezioni: punti a più di 15 km da Cave ignorati; se la mappa non risponde, è vuota o i DAE calano di oltre la metà, `dae.json` non viene toccato (GitHub manda un'email di errore).
- Se il repository resta senza modifiche per 50 giorni, il controllo registra una modifica vuota, così GitHub non sospende i controlli automatici.
- Avvio manuale: scheda Actions → "Aggiorna DAE" → Run workflow.

## Area amministratori (admin.html)

- Pagina separata, non collegata dall'app: `https://fedeopc.github.io/Cave-Informa/admin.html`. Su iPhone: Condividi → Aggiungi alla schermata Home (icona "Cave Admin").
- Chiede il codice a ogni apertura e si blocca dopo 5 minuti in sospeso; il codice non viene salvato sul telefono (si può salvare nel Portachiavi e inserire con Face ID).
- Amministratore principale: la password `ADMIN_TOKEN` del servizio Cloudflare. Dalla scheda "Direttivo" crea e revoca i codici personali dei membri del direttivo e ne sceglie le autorizzazioni.
- Avvisi, urgenti ed eventi pubblicati da qui compaiono nella stessa bacheca dell'app insieme a quelli del foglio Google.
- Dopo 10 codici sbagliati dallo stesso collegamento, l'accesso è bloccato per 15 minuti.

## Bollettini della Regione Lazio
- Il servizio Cloudflare controlla ogni 10 minuti le pagine "Allertamenti" e "Bollettini di criticità" della Regione Lazio, legge la tabella delle zone nel PDF (zona G, Bacino del Liri) e invia la notifica appena esce, di solito prima del bollettino nazionale.
- Se poi il bollettino nazionale conferma lo stesso livello, non parte una seconda notifica.
- Gli allertamenti senza tabella delle zone (per esempio solo vento) vengono ignorati.
- Controllo: pagina admin → Stato → riga "Bollettini Regione Lazio" e tasto "Leggi ora la Regione Lazio".

## Controlli di salute (pagina admin → Stato)
- Semaforo con il riassunto e l'elenco dei controlli: giro automatico, notifiche, bollettino nazionale, Regione Lazio, mappa DAE, foglio della bacheca, INGV, Open-Meteo, GitHub del Dipartimento, app e pagina admin pubblicate (versione).
- Casella "Avvisami su questo telefono se qualcosa non funziona": il semaforo segnala subito anche il primo errore; la notifica arriva solo agli amministratori se il problema dura più di mezz'ora, al massimo una volta al giorno per problema. Tasto "Prova avviso di malfunzionamento" per verificarla.
- Il servizio salva i dati solo quando cambiano: circa 150 salvataggi al giorno, sotto il limite gratuito di 1000.

## Avvisi dalla pagina admin (versione 3.11)
- Modifica di un avviso già pubblicato (di base senza inviare di nuovo la notifica).
- "Mostra fino al": l'avviso sparisce da solo dalla bacheca dopo quella data (resta in grigio nell'elenco admin).
- Pubblicazione programmata: l'avviso compare, ed eventualmente notifica, all'ora scelta (controllo ogni 10 minuti, quindi con al massimo 10 minuti di ritardo).
- Anteprima dal vivo di bacheca e notifica mentre si scrive.
- Scheda Stato: andamento dei telefoni iscritti (un conteggio al giorno).
- App: nell'elenco DAE scelta "A piedi / In auto" per le indicazioni, ricordata sul telefono.

## Notifiche a molti telefoni (piano gratuito di Cloudflare)
- Il piano gratuito permette circa 50 collegamenti esterni e 10 ms di calcolo per esecuzione: oltre 8 telefoni il servizio divide le notifiche in gruppi da 8, ognuno inviato da un'esecuzione separata di se stesso.
- Serve il collegamento interno SELF: Cloudflare → Workers & Pages → allerta-cave-push → Settings → Bindings → Add binding → Service binding, nome variabile `SELF`, servizio `allerta-cave-push`.
- Senza SELF le notifiche arrivano solo ai primi 12 telefoni; la pagina admin (Stato → "Invio a molti telefoni") lo segnala.
- Provato con 1.000 e 3.000 iscrizioni simulate: tutte raggiunte in 1–3 secondi.

## Area volontari (versione 3.15, riorganizzata nella 3.18)
- Pagina admin → Volontari → "Codici dei volontari": si crea un codice personale per ogni volontario (e lo si revoca quando serve). I codici dei volontari non entrano nella pagina admin.
- App → Info → in fondo "🔑 Area riservata ai volontari" (discreta: la sezione completa compare solo ai volontari). Il volontario apre l'app DALL'ICONA, tocca la scritta, attiva le notifiche se richiesto e inserisce il codice. Sul telefono resta solo un gettone di accesso.
- Un solo telefono per codice. Si sceglie cosa succede se il codice viene usato su un altro telefono: approvazione manuale (predefinita), sostituzione automatica del vecchio, oppure blocco (cambio telefono con "Scollega").
- Invio di attivazioni con modelli pronti e menu a tendina: titolo e messaggio si compongono da soli e restano modificabili; il messaggio non parte se restano "___" da completare.
- Il volontario risponde "Ci sono / Non posso" con una nota (dopo l'invio compare la conferma e la finestra si chiude da sola); le risposte compaiono nella pagina admin, aggiornate ogni 5 secondi (versione 3.20).
- "🏁 Concludi" (versione 3.19): chiude l'intervento, nessuno può più rispondere, notifica facoltativa "Intervento concluso". A ciascun volontario che ha risposto "Ci sono" vengono segnate presenza e ore pari alla durata intera dell'intervento (dall'invio dell'attivazione alla conclusione, arrotondata alla mezz'ora); le ore restano modificabili in Storico e presenze.
- Attivazioni già inviate: "Correggi" (con notifica facoltativa "🔁 Aggiornamento"), "Annulla" (notifica facoltativa "❌ Annullata", resta nello storico come annullata e non si può più rispondere), "Elimina" (solo amministratore principale: sparisce anche dallo storico, per prove ed errori).
- Archivio (versione 3.21): in "Attivazioni in corso" restano solo quelle aperte; concluse, annullate e messaggi informativi dopo 24 ore passano da soli in "📦 Archiviate" (ultime 10 degli ultimi 30 giorni). Nello storico le archiviate sono raggruppate per mese.
- Storico e presenze: tutte le attivazioni per anno, vista per attivazione o per volontario, presenze e ore di servizio, file per Excel. Conservazione 5 anni, poi cancellazione automatica.

## Direttivo e autorizzazioni (versione 3.18)
- Scheda "Direttivo" (solo amministratore principale): codici personali dei membri del direttivo, con autorizzazioni a scelta: avvisi in bacheca, inviare attivazioni, vedere chi risponde, codici dei volontari, storico e presenze, stato dei servizi.
- Ognuno vede solo le schede e i pulsanti autorizzati; i permessi sono controllati anche dal servizio Cloudflare. I codici creati prima della 3.18 hanno avvisi, attivazioni, chi risponde e stato.
- Le sezioni della pagina admin si aprono e chiudono toccando il titolo; si riaprono da sole quando serve attenzione (telefono da approvare, problema nei servizi).
