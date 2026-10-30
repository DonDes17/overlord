# Fork Overlord — notes

Fork personnel d’Overlord (interface web/Electron qui pilote le CLI `claude` local, multi-projets).
Ce fichier sert de contexte pour Claude Code quand on travaille sur ce repo.

## Dépôts et branches

- `origin` → https://github.com/DonDes17/overlord (le fork)
- `upstream` → https://github.com/poptocrack/overlord (l’original)
- Une branche par changement (`feat/...`, `fix/...`), testée puis fusionnée dans `main`.
- Récupérer les nouveautés de l’auteur :
  ```bash
  git switch main && git pull upstream main && npm install && git push origin main
  ```

## Lancement et environnement

- Machine : MacBook Apple Silicon, zsh + nvm, Node 22 **arm64**.
- Vérifications : `uname -m` → `arm64`, `node -p "process.arch"` → `arm64`, `node -v` → `v22.x`.
  Utiliser `/bin/zsh` (universel), pas le zsh x86 de `/usr/local/bin`.
- App desktop : `overlord-app`
  (alias : `cd ~/Desktop/overlord && OVERLORD_NODE_PATH="$(which node)" npm run dev:electron`).
  `OVERLORD_NODE_PATH` est obligatoire : sinon Electron lance le backend en `ELECTRON_RUN_AS_NODE`,
  qui n’a pas les globals Web (`Request`) → crash Hono `Class extends value undefined`.
- Mode navigateur : `npm run dev` (passe par tsx, pas besoin du fix).
- Réinstallation propre : `rm -rf node_modules package-lock.json && npm install`.
- Skills plugins visibles dans l’onglet Skills : `sync-skills` après chaque install/MAJ de plugin
  (script `~/.claude/sync-overlord-skills.sh`, symlinke `~/.claude/plugins/cache/**/skills/*/SKILL.md`
  vers `~/.claude/skills/`).

## Fonctionnement d’Overlord à connaître

- Le chat lance `claude --print` (headless). Les commandes interactives du CLI (`/clear`, `/compact`,
  `/resume`, `/permissions`, `/rewind`…) apparaissent dans l’autocomplétion mais **ne font rien**.
- Overlord intercepte ses propres commandes : `/model`, `/stop`, `/cost`, `/branch`, `/help`
  (`OVERLORD_COMMANDS` et `handleSend` dans `src/components/ChatTab.tsx`).
  Les commandes perso et plugins (`/aidd-*`…) passent au CLI et fonctionnent.
- Skills et hooks Claude Code s’appliquent dans le chat (un message = un `UserPromptSubmit`).
- Les « branches » d’Overlord sont des **sous-conversations**, pas des branches git.
- Avant chaque message, un snapshot git est pris (`server/agent/git-snapshot.ts` : `git add -A` +
  `git stash create` sur une copie temporaire de l’index) et stocké dans `snapshotSha` du message.
  Le rollback ↶ existant revient à ce snapshot **et** tronque la conversation.
- Todos : SQLite local, pas d’intégration GitHub. « Send to chat » injecte la tâche comme prompt.
- Projets filtrés par une seule racine de workspace (`isInWorkspace`), chemins absolus obligatoires.

## Changements du fork

### 1. Diff par tour — `feat/turn-diff`

Icône de diff au survol d’un message utilisateur → fenêtre plein écran : liste des fichiers avec
`+`/`−` à gauche, diff diff2html à droite (Split / Unified, choix mémorisé), Échap pour fermer.

- Plage : snapshot du message → snapshot du message suivant ; pour le dernier tour, jusqu’à l’état
  actuel des fichiers (fichiers non suivis inclus, sans toucher à l’index réel : copie temporaire
  de l’index + `GIT_INDEX_FILE`).
- Lockfiles comptés mais non affichés ; patch coupé au-delà de 3 Mo.
- Fichiers : `server/agent/git-diff.ts` (nouveau), `server/index.ts` (route `POST /api/agent/diff`),
  `src/components/TurnDiffModal.tsx` (nouveau), `src/components/ChatTab.tsx`
  (bouton + `nextSnapshotById`), `src/index.css` (import CSS diff2html).
- Dépendance : `diff2html@3.4.56` (version figée).

### 2. Annuler des changements — `feat/turn-undo`

Dans la fenêtre de diff : ↶ par fichier et « Undo turn » pour tout le tour, chacun avec un second
clic de confirmation. La conversation n’est pas modifiée.

- Implémentation : patch du tour (`--binary --no-renames`) appliqué en inverse avec `git apply -R`
  sur l’arbre de travail. Les changements des tours suivants sont conservés ; en cas de conflit,
  rien n’est écrit et l’erreur est affichée.
- Renommage : on passe l’ancien et le nouveau chemin (`oldPath` dans les stats).
- Refusé (409) tant que l’agent tourne sur le projet (`agentSessions`, `status === "running"`).
- Route : `POST /api/agent/revert` (`projectId`, `fromSha`, `toSha?`, `paths?`).
- L’agent n’est pas prévenu de l’annulation : le lui dire au message suivant.

### 3. Snapshot qui préserve le staging — `fix/snapshot-keep-index`

`createGitSnapshot` travaille sur une copie temporaire de l’index (`GIT_INDEX_FILE`) : ce que vous
aviez stagé reste stagé après l’envoi d’un message. Avant, `git add -A` puis `git reset` désindexait
tout à chaque message. Bon candidat pour une PR upstream (un seul fichier).

### 4. Commande `/branch` — `feat/branch-cmd`

Gestion des branches git depuis le chat, plus la branche courante dans l’en-tête (badge `⎇`,
relu à chaque fin d’exécution de l’agent, qui peut changer de branche lui-même).

- `/branch` : branche courante + les 20 plus récentes (triées par dernier commit), « … et N autres ».
- `/branch <nom>` : bascule sur une branche **existante** (erreur sinon, pas de création implicite).
- `/branch -c <nom>` : crée depuis le HEAD actuel et bascule dessus.
- `/branch -d <nom>` : `git branch -d` (refuse une branche non fusionnée ou la branche courante).
  La suppression forcée (`-D`) reste au terminal, pour ne pas perdre de commits par erreur.
- Les modifications non commitées suivent le changement de branche ; git refuse si elles seraient écrasées.
- Refusé (409) tant que l’agent tourne sur le projet.
- Fichiers : `server/agent/git-branch.ts` (nouveau), routes `GET` et `POST /api/agent/branch`
  dans `server/index.ts` (`POST` : `projectId`, `name`, `action` = `switch` | `create` | `delete`),
  `ChatTab.tsx` (commande + badge).

## Limites connues

- `rollbackToSnapshot` fait encore un `git reset` final : un rollback ↶ désindexe le staging.
  Même correctif possible (index temporaire), pas fait.

## Feuille de route

| Ordre | Changement | Branche |
|---|---|---|
| 3 ✅ | Snapshot qui préserve le staging | `fix/snapshot-keep-index` |
| 4 ✅ | `/branch` + branche courante dans l’en-tête | `feat/branch-cmd` |
| 5 | `/clear` (vider `claudeSessionId`) et `/resume` (sessions de `~/.claude/projects/<chemin-encodé>/*.jsonl`) | `feat/session-cmds` |
| 6 | `/plan` (`--permission-mode plan`) | `feat/plan-mode` |
| 7 | Worktrees : deux tâches en parallèle sur un même repo | `feat/worktrees` |
| — | Annulation par bloc (hunk) dans la fenêtre de diff | à définir |
| — | Index temporaire aussi dans `rollbackToSnapshot` | à définir |

## Repères pour développer

- Routes agent : `server/index.ts`, à côté de `/api/agent/rollback`.
- Session agent : `server/agent/types.ts` (`AgentSession`, `Channel`), `server/agent/sessions.ts`.
- Lancement du CLI : `server/agent/send-message.ts`.
- Thème : toujours sombre (`<html class="dark">` dans `index.html`).
- Vérifier avant de committer : `npx tsc --noEmit -p .` puis `npx vite build`.

## Pièges rencontrés

- macOS peut refuser l’accès à `~/Desktop` au processus `claude` (`Operation not permitted`) même
  quand le terminal y accède. Remède : `tccutil reset SystemPolicyDesktopFolder`, redémarrer, ou
  garder les projets hors du Bureau (par exemple `~/Developer`).
- Une PR se crée sur le fork avec `gh pr create --repo DonDes17/overlord --base main --head <branche>`
  (sans `--repo`, `gh` vise `poptocrack/overlord`). Fixer une fois : `gh repo set-default DonDes17/overlord`.
- `gh pr create --fill` échoue sans `origin/main` en local : faire `git fetch origin` avant.
