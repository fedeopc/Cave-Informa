# Allerta Cave

App di emergenza per Cave (RM), installabile su iPhone e Android senza App Store.

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
5. Dopo un minuto l'app sarà online a un indirizzo tipo `https://tuonome.github.io/allerta-cave/`.

L'indirizzo deve essere https, altrimenti installazione e modalità offline non funzionano. GitHub Pages lo fa già da solo.

## Installazione

- **iPhone**: apri l'indirizzo in Safari, tocca Condividi e poi "Aggiungi alla schermata Home".
- **Android**: apri l'indirizzo in Chrome e tocca "Installa app" (oppure menu ⋮ → "Aggiungi a schermata Home").

Dopo la prima apertura, guide, zaino e numeri funzionano anche senza connessione.

## Aggiornare l'app

1. Modifica i file e ricaricali su GitHub.
2. In `sw.js` aumenta la versione, per esempio da `allerta-cave-v1` a `allerta-cave-v2`.

Così i telefoni scaricano la nuova versione alla prossima apertura con internet.

## Allerta di oggi

La prima pagina mostra il livello di allerta di oggi e di domani per Cave, per la posizione del telefono o per un altro comune scelto dall'utente. I dati vengono dal bollettino nazionale di criticità del Dipartimento della Protezione Civile, pubblicato come dato aperto (CC BY 4.0) su github.com/pcm-dpc/DPC-Bollettini-Criticita-Idrogeologica-Idraulica.

- L'app cerca un nuovo bollettino al massimo ogni 20 minuti e salva l'ultimo scaricato, così funziona anche senza connessione.
- La posizione viene usata solo sul telefono per trovare la zona di allerta e non viene inviata a nessuno.
