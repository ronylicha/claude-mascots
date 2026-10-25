# Protocole série claude-mascots — v2

Liaison PC → carte : USB-série, **115200 bauds, 8N1**, une trame JSON par ligne terminée par `\n`, ASCII uniquement.
Le démon envoie une trame par seconde (`host/src/transport/deviceFrame.ts`) ; la carte la décode avec
`firmware/lib/protocol/protocol.cpp`. Une trame complète (6 sessions, valeurs maximales) tient sous
**4 000 octets** (`q2` et `pv` ajoutent au plus 80 octets : 25 pour `q2`, 9 par session pour `pv`) ; la carte accepte
des lignes de **4 095 octets** au plus.

La v2 remplace les espèces animales de la v1 par des humains (peau, cheveux, coiffure) et transmet
tout ce qu'affiche la vue détaillée d'une session sur l'écran tactile. Les sessions Codex (compte OpenAI) et
leur quota s'ajoutent à Claude Code par des champs **facultatifs** (`q2`, `pv`) : la version reste `2`.

## Trame PC → carte

```json
{"v":2,"t":1792805400,"lt":[22,15],"q":[42,90,1,1044],"q2":[-1,-1,29,1440],"tot":{"c":1235,"r":12608,"n":2,"w":1},
 "s":[{"id":"0702150f","n":"projects-50","h":203,"sk":1,"hc":3,"hs":0,"pv":"c","a":"w","m":"f","mc":"-",
       "k":"s","tn":"WebSearch","x":32,"cw":200,"r":10397,"c":307,"md":"Opus 5.5","p":"claude-mascots",
       "u":184,"up":95,"ld":4,"ti":1520,"to":88213,"tr":15022918,"tw":412877,
       "tc":[52,31,40,6,3,90,12],"hh":[0,0,1200,8400,10397,9800,7200,0,0,0,3100,5400,6000,9100,10397]}]}
```

| Champ | Type | Sens |
|-------|------|------|
| `v` | entier | Version du protocole (`2`). Une carte refuse toute autre version. |
| `t` | entier | Horodatage Unix (secondes) de la trame. |
| `lt` | `[int, int]` | Heure et minute **locales** du PC : la fenêtre de la chambre suit le jour et la nuit (heure inconnue : la carte affiche le jour). |
| `q` | `[int, int, int, int]` | Quota du compte Anthropic (Claude Code) : `[% fenêtre 5 h, minutes avant reset 5 h, % fenêtre 7 j, minutes avant reset 7 j]`. `-1` = inconnu. Obligatoire. |
| `q2` | `[int, int, int, int]` | Quota du compte OpenAI (sessions Codex), même forme que `q`. **Facultatif** : absent ou mal formé (pas un tableau de 4 entiers), les quatre valeurs valent `-1` et la trame reste valide. |
| `tot.c` | entier | Coût cumulé de toutes les sessions, en **centimes** de dollar. |
| `tot.r` | entier | Tokens facturables par minute, toutes sessions (moyenne glissante sur 5 min). |
| `tot.n` / `tot.w` | entier | Nombre total de sessions / sessions au travail (peut dépasser 6). |
| `s` | tableau | Au plus **6** sessions, celles au travail en premier. |

### Session (`s[]`)

| Champ | Sens | Valeurs |
|-------|------|---------|
| `id` | Identifiant court (**8 derniers** caractères de l'identifiant de session) | permet à la carte de garder la session ouverte en vue détaillée d'une trame à l'autre |
| `pv` | Fournisseur de la session (facultatif) | `c` Claude Code, `x` Codex ; absent ou autre valeur : Claude Code |
| `n` | Nom (≤ 12 caractères ASCII) | `projects-50` |
| `h` | Teinte du t-shirt et de la couverture | `0`–`359` |
| `sk` / `hc` / `hs` | Teint de peau / couleur de cheveux / coiffure (index) | `0`–`3` / `0`–`5` / `0` courts, `1` longs, `2` chignon |
| `a` | Activité | `w` travaille, `a` attend une réponse, `i` au repos, `s` dort |
| `m` | Humeur | `h` content, `f` concentré, `t` fatigué (contexte ≥ 70 %), `w` inquiet (quota 5 h ≥ 80 % ou 7 j ≥ 85 %), `x` épuisé (quota 5 h ≥ 95 % ou contexte ≥ 90 %) |
| `mc` | Cause de l'humeur | `q` quota 5 h, `w` quota de la semaine, `x` contexte, `-` aucune |
| `k` | Outil en cours | `r` lecture, `e` écriture, `b` commande, `s` recherche, `d` délégation, `t` réflexion, `o` autre, `-` aucun |
| `tn` | Nom de l'outil en cours (≤ 16 caractères ASCII) | `""` si aucun |
| `x` | Contexte utilisé (%) | `-1` = inconnu, y compris quand le comptage de tokens de la session n'est pas fiable (`usageReliable: false` côté démon : amont qui ne transmet pas `usage`) |
| `cw` | Taille de la fenêtre de contexte, en **milliers** de tokens | `-1` = inconnue |
| `r` | Tokens facturables / min (moyenne sur 5 min) | entier |
| `c` | Coût de la session (centimes) | `-1` = inconnu (ou comptage non fiable, comme `x`) |
| `md` | Modèle (≤ 16 caractères ASCII) | `""` si inconnu |
| `p` | Dossier de travail (≤ 16 caractères ASCII) | `claude-mascots` |
| `u` | Réponses de l'assistant depuis le début | entier |
| `up` | Minutes depuis le démarrage de la session | entier |
| `ld` | Secondes depuis la dernière activité | `-1` = inconnu |
| `ti` / `to` / `tr` / `tw` | Tokens cumulés : entrée non cachée / sortie / lectures de cache / écritures de cache | entiers (peuvent dépasser 2³¹ : décodés sur 64 bits) |
| `tc` | Appels d'outil par catégorie, **7** entiers | ordre `r e b s d t o` (le compteur `t` compte les blocs de réflexion) |
| `hh` | Historique des tokens facturables / min, **15** points | moyennes par tranches de 2 minutes sur les 30 dernières minutes, du plus ancien au plus récent |

Les textes (`id`, `n`, `tn`, `md`, `p`) sont convertis en ASCII imprimable (accents retirés) car les polices
bitmap de la carte n'ont que l'ASCII. Les guillemets et antislash sont supprimés : JSON les double, ce qui
ferait dépasser les 4 000 octets à une trame pire cas.

## Décodage côté carte

`parseFrame` (`firmware/lib/protocol/protocol.cpp`) rejette la trame entière, sans toucher à la précédente,
si un champ **obligatoire** manque : `v`, `t`, `q` (4 entiers), `tot`, `s`, et par session `id`, `n`, `a`, `m`
(`n` peut être vide). Tout autre champ absent prend la valeur par défaut de `model.h`, dont `q2` (quota Codex,
`Frame::quota[PROVIDER_CODEX]` : `-1` partout s'il est absent ou mal formé, sans rejeter la trame) et `pv`
(`Session::provider` : `PROVIDER_CODEX` pour `"x"`, `PROVIDER_CLAUDE` sinon). Le quota `q` est rangé dans
`Frame::quota[PROVIDER_CLAUDE]`. Les tableaux `tc` (7)
et `hh` (15) peuvent être trop courts (le reste vaut 0) ; l'excédent est ignoré. Les entiers hors plage sont
ramenés à la borne du type du modèle, les chaînes tronquées sans couper un caractère UTF-8, et les sessions
au-delà de la sixième ignorées.

Les codes d'outil sont la source de vérité côté démon (`TOOL_CODE` dans `deviceFrame.ts`) ; les nombres de
teints, de couleurs et de coiffures viennent de `host/src/domain/avatar.ts` et doivent correspondre à
`shared/sprites.json` (vérifié par `host/test/sprites.test.ts`). L'en-tête `firmware/include/sprites_gen.h`
est **généré** depuis `shared/sprites.json` (`pnpm sprites`, vérifié par `pnpm sprites:check`).

## Lignes carte → PC

| Ligne | Quand |
|-------|-------|
| `HELLO mascots v2 esp32-2432s028 320x240 invert=1 rotation=1 touch=calibrated panel=<0x04>/<0xD3>` | Au démarrage (le démon la journalise). `touch` vaut `calibrated` (calibration mémorisée en flash) ou `default` (calibration abandonnée faute d'appui : le tactile peut être décalé). `panel` = réponses brutes du contrôleur aux commandes d'identification, en hexadécimal ; `0xD3` vaut `00009341` sur un ILI9341 et `00000000` sur un ST7789. |
| `TOUCH <x> <y> <vue>` | À chaque tap, émise **quand le doigt se relève** (contact d'au moins deux mesures espacées de 15 ms, de moins d'une seconde, sans glissement de plus de 30 pixels). `x`, `y` : coordonnées écran 0–319 / 0–239 après calibration, moyenne du contact. `vue` : vue affichée **avant** le tap (`grid` ou `detail`). Un appui sur BOOT n'en produit pas ; pendant la calibration, aucune. |
| `ERR trame rejetee : <raison>` | Trame invalide (JSON, version, champs manquants). |
| `ERR ligne trop longue` | Ligne > 4 095 octets. |
| `PONG` | Réponse à une ligne `PING`. |

## Évolution

Tout changement incompatible incrémente `v` côté démon **et** firmware dans le même commit ;
un champ ajouté et ignoré par l'ancienne version n'en exige pas (c'est le cas de `q2` et `pv`).
