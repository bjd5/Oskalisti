# Óskalisti 🎁

Vefsíða með óskalistanum okkar svo vinir og fjölskylda viti hvað má gefa okkur í gjöf –
hvort sem það er í jólagjöf, afmælisgjöf, innflutningsgjöf eða við önnur tilefni.

## Hvað getur síðan gert?

**Fyrir þá sem ætla að gefa gjöf**
- Skoða allar gjafirnar með mynd, verði og hvar hægt er að kaupa þær (hlekkir beint á vöruna).
- Flokka eftir flokkum: *Í eldhúsið, Fyrir heimilið, Hjónarúmið, Borðstofan, Annað* (og öðrum sem þið búið til).
- Velja verðbil (0–5.000 kr., 5.000–10.000 kr., 10.000–15.000 kr. o.s.frv.) og fá **hugmyndir að gjöfum** í því verðbili
  – og tillögur að tveimur minni gjöfum saman ef fátt passar.
- Raða eftir verði (lægst/hæst fyrst), nafni eða nýjustu.
- Sjá hvaða gjafir er búið að gefa svo enginn kaupi það sama tvisvar.

**Fyrir ykkur (aðgangur með kóða – „developer access“)**
- Smellið á **🔑 Aðgangur** neðst á síðunni (eða farið á `/#admin`) og sláið inn aðgangskóðann.
- **Bæta við gjöf:** skrifið hvað ykkur langar í (t.d. „Le Creuset pottur 24 cm“) *eða* límið inn hlekk á vöruna.
  Síðan finnur verð, verslun og mynd og þið veljið niðurstöðu (hægt að bæta við fleiri verslunum fyrir sömu gjöf).
  Allt má líka fylla út eða laga handvirkt.
- **Haka við keyptar gjafir**, breyta, eyða, merkja sem „efst á óskalistanum“.
- Búa til, endurnefna og eyða flokkum og breyta titli/texta síðunnar.

## Á GitHub Pages (ókeypis, enginn þjónn)

Síðan keyrir beint á GitHub Pages: **https://bjd5.github.io/Oskalisti/**

Þar er enginn vefþjónn, svo hún virkar svona:
- Óskalistinn er skráin [`public/data/oskalisti.json`](public/data/oskalisti.json) í þessu repoi.
- **Aðgangskóðinn er GitHub-lykill** (fine-grained personal access token). Þegar þið bætið við gjöf eða hakið við
  vistar síðan breytinguna beint í skrána í repoinu. Þá fer GitHub Action af stað og eftir **um það bil mínútu**
  sjá gestir breytinguna (þið sjáið hana strax).
- **Sjálfvirk vöruleit** (verð, verslun, mynd) þarf **Claude API-lykil** sem þið setjið inn við innskráningu.
  Claude leitar þá á netinu fyrir ykkur, bæði eftir nafni og eftir hlekk. Án lykils fyllið þið út upplýsingarnar sjálf.
- Báðir lyklarnir eru **bara geymdir í ykkar vafra** (localStorage). Þeir fara aldrei í repoið. „Skrá út“ eyðir þeim.

### Uppsetning (einu sinni)

1. **Gera repoið public:** Settings → General → neðst „Danger Zone“ → *Change visibility* → Public.
   (GitHub Pages er bara ókeypis fyrir public repo. Það sjást engir lyklar eða kóðar, bara kóðinn og óskalistinn.)
2. **Setja kóðann á `main`:** sameinið (merge) þessa grein inn í `main`.
3. **Kveikja á Pages:** Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
   Keyrið svo „GitHub Pages“-workflowið undir Actions (eða ýtið einhverju á `main`).
4. **Búa til aðgangskóða:** https://github.com/settings/personal-access-tokens/new
   - *Repository access:* Only select repositories → **Oskalisti**
   - *Permissions → Repository permissions → Contents:* **Read and write**
   - Afritið lykilinn (`github_pat_…`). Hann er aðgangskóðinn. Hver sem fær hann getur breytt listanum,
     og þið getið afturkallað hann hvenær sem er.
5. *(Valfrjálst)* **Claude API-lykill** fyrir sjálfvirka leit: https://console.anthropic.com → API keys.
   Hver leit kostar örlítið.
6. Farið á síðuna → **🔑 Aðgangur** neðst → límið inn GitHub-lykilinn (og Claude-lykilinn) → Skrá inn.

Ef annað repo eða önnur grein er notuð þarf að breyta [`public/config.json`](public/config.json).

## Keyra á eigin tölvu (Node-þjónn)

Í staðinn fyrir GitHub Pages er líka hægt að keyra síðuna sem venjulegan vefþjón. Þá er vöruleitin
öflugri, því þjónninn getur sjálfur lesið vörusíður (líka án Claude-lykils).

Þarf [Node.js](https://nodejs.org) 22.9 eða nýrra.

```bash
npm install
```

```bash
npm start
```

Opnið svo http://localhost:3000. Ef þið hafið ekki sett `ADMIN_CODE` býr síðan sjálf til aðgangskóða,
skrifar hann í loggið og vistar hann í `data/admin-code.txt`.

Stillingar fara í skrá sem heitir `.env` (afritið `.env.example`):

| Breyta | Lýsing |
|---|---|
| `ADMIN_CODE` | Aðgangskóðinn til að breyta listanum. Þeir sem fá hann geta bætt við gjöfum og hakað við. |
| `ANTHROPIC_API_KEY` | *Valfrjálst.* Lykill að Claude API. Þá getur síðan leitað að vöru eftir **nafni** á netinu (sjá að neðan). |
| `PORT` | Port fyrir vefþjóninn (sjálfgefið 3000). |
| `DATA_DIR` | Mappa þar sem listinn er vistaður (sjálfgefið `./data`). |
| `SESSION_SECRET` | *Valfrjálst.* Leynilykill fyrir innskráningarköku. Sjálfgefið leitt af `ADMIN_CODE`, svo ef kóðanum er breytt skráist allir út. |
| `ANTHROPIC_MODEL` | *Valfrjálst.* Hvaða Claude líkan er notað við leit (sjálfgefið `claude-opus-5-5`). |
| `TRUST_PROXY` | *Valfrjálst.* Fjöldi proxy-þjóna fyrir framan síðuna (sjálfgefið 1, sem passar fyrir Railway/Fly/Render). |

## Hvernig vöruleitin virkar

1. **Hlekkur á vöru** (virkar alltaf, enginn lykill): síðan sækir vörusíðuna og les verð, nafn og mynd úr
   upplýsingum sem flestar vefverslanir setja í síðuna (JSON-LD / Open Graph / Shopify). Verð í erlendri mynt er
   umreiknað gróflega í krónur.
2. **Nafn á vöru með `ANTHROPIC_API_KEY`:** Claude leitar á netinu (helst í íslenskum vefverslunum), finnur
   vörusíður, verð í krónum og mynd og síðan staðfestir/fyllir í myndir og verð beint af vörusíðunum.
   Leitin getur tekið allt að mínútu og kostar örlítið per leit á Claude API.
3. **Nafn á vöru án lykils:** einföld leit í gegnum DuckDuckGo sem reynir að lesa úr efstu niðurstöðunum.
   Þetta er „best-effort“ – ef ekkert finnst er best að líma inn hlekk.

Verð breytast og verslanir breyta síðunum sínum, svo þið getið alltaf lagað verð, mynd og verslanir handvirkt.

## Setja Node-útgáfuna á netið

Síðan er venjulegur Node.js vefþjónn og listinn er vistaður í **einni JSON-skrá** (`DATA_DIR/oskalisti.json`).
Það skiptir máli að hýsingin hafi **varanlegt diskpláss** – annars týnist listinn þegar síðan er endurræst.

Dæmi um hýsingu sem virkar:
- **Railway** eða **Fly.io**: tengið GitHub-repoið (eða notið `Dockerfile`), búið til *volume*,
  tengið það við `/data` og setjið `DATA_DIR=/data`, `ADMIN_CODE` og (valfrjálst) `ANTHROPIC_API_KEY`.
- **Render**: virkar líka, en þarf „Persistent Disk“ (ekki í boði í ókeypis útgáfunni).
- **Eigin vél / VPS**: `npm ci --omit=dev && npm start` á bak við t.d. Caddy eða nginx með HTTPS.

Með Docker:

```bash
docker build -t oskalisti .
```

```bash
docker run -p 3000:3000 -v oskalisti-data:/data -e ADMIN_CODE=leyndo oskalisti
```

**Afrit:** takið reglulega afrit af `oskalisti.json` – það er allur listinn.

## Uppbygging

```
server/
  index.js          ræsir vefþjóninn
  app.js            Express-appið og API-leiðir
  store.js          vistun í JSON-skrá (atómískar skriftir)
  auth.js           aðgangskóði og innskráningarkaka
  routes/           API: gjafir, flokkar, stillingar, innskráning, leit
  lookup/           vöruleit: lesa vörusíður, Claude-leit, DuckDuckGo-leit
public/             vefsíðan sjálf (HTML/CSS/JS, engin build-skref) – þetta fer á GitHub Pages
  app.js            framendinn
  github-backend.js „bakendi“ í vafranum fyrir GitHub Pages (vistar í repoið)
  shared/           gagnareglur og Claude-leit sem bæði þjónninn og vafrinn nota
  data/             óskalistinn sjálfur á GitHub Pages
  vendor/           Anthropic SDK pakkað fyrir vafrann (`npm run build:vendor`)
.github/workflows/  birtir public/ á GitHub Pages við hverja breytingu á main
test/               prófanir (`npm test`)
```

## Prófanir

```bash
npm test
```
