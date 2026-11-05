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

## Á GitHub Pages + Google Sheet (ókeypis, engir lyklar)

Síðan keyrir á GitHub Pages: **https://bjd5.github.io/Oskalisti/**

GitHub Pages getur ekki vistað neitt sjálft, svo **óskalistinn er geymdur í Google Sheet**:
- Gestir lesa listann úr töflureikninum. Þeir þurfa ekkert að skrá sig inn.
- Þið skráið ykkur inn með **ykkar eigin aðgangskóða**, sem er skrifaður í töflureikninn
  (flipinn **Aðgangur**, reitur **B1**). Engir API-lyklar og engin GitHub-innskráning.
  Kóðanum breytið þið hvenær sem er með því að skrifa nýjan kóða í reitinn.
- Allt sem þið bætið við eða hakið við vistast strax í töflureikninum. Þið getið líka skoðað og
  lagað gjafirnar beint í honum (t.d. skrifað „já“ í dálkinn *Keypt*).
- **Vöruleit:** límið inn hlekk á vöruna og síðan les verð, nafn, verslun og mynd af vörusíðunni.
  Leit eftir nafni (án hlekks) er „best-effort“.
- **Verðsamanburður:** þegar þið veljið vöru leitar síðan sjálfkrafa að **sömu vöru** í öðrum
  íslenskum verslunum og sýnir verðin, ódýrast efst. Þið bætið þeim verslunum við sem þið viljið
  (eða öllum). Hnappurinn **„Bera saman verð í öðrum verslunum“** gerir það sama hvenær sem er.
  - Leitað er beint í verslununum: **Líf og List, Kúnígúnd, Byggt og búið og Kokka** (engir lyklar).
  - Varan telst sú sama ef **vörunúmer framleiðanda** er það sama (t.d. Global **G-5** – sem heitir
    „Global Nakiri hnífur 18cm“ hjá Kúnígúnd en „Grænmetishnífur 18cm - G-5“ hjá Líf og List – eða
    vörunúmer Le Creuset). Ef vörunúmer vantar er borið saman eftir merki, stærð og nafni og það
    merkt „Líklega sama vara“.
  - Hjá Kúnígúnd og Byggt og búið sést aðeins hluti vörumerkjasíðunnar án JavaScript, svo stundum
    finnst vara þar ekki þó hún sé til.
  - Fleiri verslunum má bæta við í `server/lookup/compare.js` (`SHOPS`).

### Uppsetning (einu sinni, um 5 mínútur)

1. Búið til nýjan Google Sheet: https://sheets.new (t.d. með nafninu „Óskalisti“).
2. Í töflureikninum: **Extensions → Apps Script**. Eyðið því sem er í ritlinum og límið inn
   allan kóðann úr [`apps-script/Code.gs`](apps-script/Code.gs). Vistið (Ctrl/Cmd + S).
3. Veljið fallið **setup** í fellilistanum efst og ýtið á **Run**. Google biður um leyfi:
   *Review permissions* → veljið reikninginn → *Advanced* → *Go to … (unsafe)* → *Allow*.
   (Google varar við af því að þetta er ykkar eigin kóði sem Google hefur ekki yfirfarið.)
4. Farið aftur í töflureikninn. Þar eru komnir flipar: *Gjafir, Flokkar, Stillingar, Aðgangur*.
   Skrifið **aðgangskóðann ykkar í reit B1** í flipanum *Aðgangur*.
5. Í Apps Script: **Deploy → New deployment** → tannhjólið → **Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**

   Ýtið á **Deploy** og afritið **Web app URL** (endar á `/exec`).
6. Setjið slóðina í [`public/config.json`](public/config.json) sem `"url"` (eða sendið hana Claude).
   Þegar breytingin er komin á `main` birtist síðan eftir um mínútu.
7. Farið á síðuna → **🔑 Aðgangur** neðst → sláið inn kóðann → **+ Bæta við gjöf**.

Ef `Code.gs` er uppfærður seinna: límið nýja kóðann inn og veljið **Deploy → Manage deployments →
✏️ → Version: New version → Deploy** (þá helst sama slóð).

## Keyra á eigin tölvu (Node-þjónn)

Í staðinn fyrir GitHub Pages + Google Sheet er líka hægt að keyra síðuna sem venjulegan vefþjón
(þá er `public/config.json` hunsað og þjónninn geymir listann sjálfur).

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
  sheets-backend.js tengingin við Google Sheet (notuð á GitHub Pages)
  config.json       slóðin á Apps Script-ið
  shared/           gagnareglur sem bæði þjónninn og vafrinn nota
  vendor/lookup.js  vörusíðulesarinn pakkaður fyrir vafrann (`npm run build:vendor`)
apps-script/Code.gs kóðinn sem fer í Google Sheet (Extensions → Apps Script)
.github/workflows/  birtir public/ á GitHub Pages við hverja breytingu á main
test/               prófanir (`npm test`)
```

## Prófanir

```bash
npm test
```
