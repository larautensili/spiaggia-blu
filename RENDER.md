# Deploy su Render.com (gratuito)

## Struttura repository (obbligatoria)

```
spiaggia-blu/          ← root del repo GitHub
├── render.yaml
├── RENDER.md
├── backend/
│   ├── server.js
│   ├── mail.js
│   ├── package.json
│   ├── entry.js
│   └── db/
│       └── data.json
└── frontend/
    ├── index.html
    ├── css/style.css
    ├── js/app.js
    └── uploads/
```

## Passo 1 – Metti il progetto su GitHub

1. Crea un account su https://github.com
2. **New repository** → nome `spiaggia-blu` → **Public** → Create
3. Carica tutti i file (Upload files oppure GitHub Desktop / `git push`)

## Passo 2 – Crea il servizio su Render

### Metodo A – Blueprint (consigliato)

1. Vai su https://dashboard.render.com
2. Registrati con GitHub
3. **New** → **Blueprint**
4. Seleziona il repository `spiaggia-blu`
5. Render legge `render.yaml` e propone il servizio
6. **Apply** / **Create**

### Metodo B – Manuale

1. **New** → **Web Service**
2. Collega il repo `spiaggia-blu`
3. Impostazioni:
   | Campo | Valore |
   |-------|--------|
   | Name | `spiaggia-blu` |
   | Region | Frankfurt |
   | Root Directory | `backend` |
   | Runtime | Node |
   | Build Command | `echo ok` |
   | Start Command | `node server.js` |
   | Instance type | **Free** |
4. **Create Web Service**

## Passo 3 – Attendi il deploy

- Dopo 1–3 minuti lo stato diventa **Live**
- URL pubblico tipo: `https://spiaggia-blu-xxxx.onrender.com`
- Aprilo nel browser

## Login demo

- **Admin:** `admin@spiaggiablu.it` / `Admin123!`
- **Utente:** `mario@email.com` / `User123!`

## Note importanti (piano Free)

1. **Sleep:** dopo ~15 minuti di inattività il servizio si spegne.  
   Il primo accesso successivo può richiedere 30–60 secondi.
2. **Dati:** `data.json` è su disco temporaneo.  
   A ogni **redeploy** i dati possono resettarsi. Per i test va bene.
3. **Stripe / email:** in Dashboard → Environment aggiungi:
   - `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `ADMIN_NOTIFY_EMAIL`
4. **Health check:** `GET /api/health` deve rispondere `{"status":"ok",...}`

## Aggiornare l’app

1. Modifica i file e fai push su GitHub
2. Render ridistribuisce in automatico (se Auto-Deploy è attivo)

## Risoluzione problemi

| Problema | Soluzione |
|----------|-----------|
| Build failed | Root Directory = `backend`, Start = `node server.js` |
| Pagina bianca / 404 static | Verifica che `frontend/` sia nel repo allo stesso livello di `backend/` |
| Timeout al primo accesso | Normale sul Free: aspetta 1 minuto e ricarica |
| Porto | Non impostare PORT a mano: lo gestisce Render |
