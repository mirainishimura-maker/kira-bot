# Correcciones de ITACA por WhatsApp (Mia → GitHub → PR)

Mia lee **en silencio** el grupo *"conversemos las tres"*, convierte cada
corrección (texto / audio / imagen) en algo accionable y te la manda a tu
privado. Con tu `/ok N`, abre un issue en GitHub que **Claude implementa en una
rama y deja como Pull Request**. Tú apruebas el PR desde el celular → Railway
despliega → Mia te avisa. **Nada llega a producción sin tu aprobación.**

```
Gaby manda audio/foto/texto al grupo
        │  (Mia lee, muda en el grupo)
        ▼
Mia transcribe/describe + clasifica (Claude)
        │
        ▼
Mia te escribe a tu privado:
   "📝 Corrección #7 (Gaby): ...  /ok 7  ·  /descartar 7"
        │  tú: /ok 7
        ▼
Mia abre un issue @claude  →  GitHub Action implementa  →  PR en una rama
        │
        ▼
Mia te avisa: "🔧 #7 lista, revisa el PR: <link>"
        │  tú apruebas (merge) desde el cel
        ▼
Railway despliega  →  Mia: "✅ #7 en producción, dile a Gaby que revise"
```

---

## Pasos manuales (una sola vez)

### 1. Repo de ITACA — instalar Claude + el workflow
El workflow ya está creado en `.github/workflows/claude.yml`. Falta activarlo:

- **Opción fácil:** en una terminal, dentro de `C:\projects\itaca-conversemos`,
  corre Claude Code y ejecuta el comando `/install-github-app`. Instala el
  Claude GitHub App en el repo y te ayuda a agregar el secreto. (Necesitas ser
  **admin** del repo `conversemositaca-tech/itaca-conversemos`.)
- **Manual:** en GitHub → repo → *Settings → Secrets and variables → Actions →
  New repository secret*: nombre `ANTHROPIC_API_KEY`, valor tu API key de
  https://console.anthropic.com . Luego commitea el archivo `claude.yml`.

> Costo: cada corrección consume tokens de tu cuenta de Anthropic (la del
> `ANTHROPIC_API_KEY`). Para un grupo de 3 personas el volumen es bajo.

### 2. Token de GitHub para Mia (para que abra los issues)
En GitHub → *Settings (tu cuenta) → Developer settings → Personal access tokens
→ Fine-grained tokens → Generate new token*:
- **Repository access:** solo `conversemositaca-tech/itaca-conversemos`.
- **Permissions → Repository:** `Issues` = Read and write, `Pull requests` =
  Read-only, `Contents` = Read-only, `Metadata` = Read-only.
- Copia el token y ponlo en **EasyPanel** (servicio de kira-bot) como
  variable de entorno `GITHUB_TOKEN`.

### 3. Tabla en Supabase
En el **Supabase privado de Mirai** (el de `MIRAI_SUPABASE_URL`, donde vive
`patients`) → *SQL Editor* → pega y corre el contenido de
`supabase/mirai_itaca_correcciones.sql`.

### 4. Capturar el ID del grupo
1. Manda cualquier mensaje en el grupo *"conversemos las tres"*.
2. Desde tu WhatsApp personal, escríbele a Mia: `/grupos`.
3. Te devuelve la lista de grupos con su JID (algo como `120363xxxxx@g.us`).
4. Copia el JID del grupo correcto y ponlo en EasyPanel como `ITACA_GROUP_JID`.
5. **Redespliega** el servicio en EasyPanel.

---

## Variables de entorno (EasyPanel · kira-bot)

| Variable | Para qué | Ejemplo |
|---|---|---|
| `ITACA_GROUP_JID` | Grupo que Mia lee (obligatoria para activar todo) | `120363...@g.us` |
| `GITHUB_TOKEN` | Que Mia abra issues | `github_pat_...` |
| `ITACA_REPO` | Repo destino (ya tiene default) | `conversemositaca-tech/itaca-conversemos` |
| `ITACA_DEBOUNCE_MS` | Cuánto espera para agrupar mensajes seguidos (opcional) | `60000` |

Reusa `ANTHROPIC_API_KEY` (clasificación) y `MIRAI_OPENAI_API_KEY`
(transcripción de audios y visión de imágenes), que ya están configuradas.

**Sin `ITACA_GROUP_JID` nada de esto se activa** — el bot se comporta igual que
antes.

---

## Comandos (desde tu WhatsApp personal, a Mia)

| Comando | Qué hace |
|---|---|
| `/correcciones` | Lista las correcciones pendientes con su número y estado |
| `/ok 7` | Implementa la corrección #7 (abre issue → PR) |
| `/descartar 7` | Descarta la corrección #7 |
| `/grupos` | Lista JIDs de grupos vistos (para setear `ITACA_GROUP_JID`) |

## Estados de una corrección
`pendiente` → `en_progreso` (issue creado) → `pr_abierto` (PR listo, revísalo) →
`en_produccion` (mergeado y desplegado). También `descartada` y `error`.

## Probar sin esperar el cron
El seguimiento de PRs corre cada 3 min. Para forzarlo (ej. justo después de
aprobar un PR):
`POST /admin/itaca-prs` con el header `x-admin-secret: <WEBHOOK_SECRET>`.
