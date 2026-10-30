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
- **Node doit être la v22** au lancement : `better-sqlite3` est compilé pour elle. Avec une autre version
  (par exemple la v20 après un redémarrage), le backend plante avec `NODE_MODULE_VERSION 127 … requires
  115`. Remède : `nvm use 22` (et `nvm alias default 22` pour le fixer), sans recompiler.
- Mode navigateur : `npm run dev` (passe par tsx, pas besoin du fix).
- Réinstallation propre : `rm -rf node_modules package-lock.json && npm install`.
- Skills plugins visibles dans l’onglet Skills : `sync-skills` après chaque install/MAJ de plugin
  (script `~/.claude/sync-overlord-skills.sh`, symlinke `~/.claude/plugins/cache/**/skills/*/SKILL.md`
  vers `~/.claude/skills/`).

## Fonctionnement d’Overlord à connaître

- Le chat lance `claude --print` (headless). Les commandes interactives du CLI (`/compact`,
  `/permissions`, `/rewind`…) apparaissent dans l’autocomplétion mais **ne font rien**.
  (`/clear` et `/resume` sont désormais gérées par Overlord, voir ci-dessous.)
- Overlord intercepte ses propres commandes : `/model`, `/stop`, `/cost`, `/branch`, `/clear`, `/resume`, `/plan`, `/worktree`, `/merge`, `/help`
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
- **Par bloc (hunk)** — `feat/hunk-undo` : un bouton `↶ Undo block` dans l'en-tête de chaque bloc du diff
  (Split et Unified), avec le même second clic de confirmation (il se désarme seul après 4 s).
  `POST /api/agent/revert` accepte `hunk: { path, index, header }` ; `revertHunk` (`git-diff.ts`) recalcule le
  patch du fichier, en extrait le bloc et l'applique en inverse (`git apply -R`, même `applyReverse` que
  l'annulation de tour). Le bloc est identifié par sa **position et ses numéros de ligne** (`@@ -a,b +c,d @@`) :
  si le diff a changé depuis l'affichage, c'est refusé (« fermez et rouvrez la fenêtre ») plutôt que d'annuler
  un autre bloc. Le client n'envoie jamais de texte de patch. Les décalages de lignes dus aux tours suivants
  sont absorbés par `git apply` ; un conflit n'écrit rien. Pas de bouton pour les fichiers binaires,
  lockfiles et renommés. diff2html ne permettant pas d'ajouter des boutons, ils sont injectés dans le DOM
  après chaque rendu (`TurnDiffModal.tsx`, sélecteurs `td.d2h-info` + `d2h-code-line` / `d2h-code-side-line`).
  Pour un tour passé, le diff est entre deux snapshots fixes et ne change pas après l'annulation : le bouton
  passe à `✓ Undone` (état gardé en mémoire tant que la fenêtre est ouverte).

### 3. Snapshot qui préserve le staging — `fix/snapshot-keep-index`

`createGitSnapshot` travaille sur une copie temporaire de l’index (`GIT_INDEX_FILE`) : ce que vous
aviez stagé reste stagé après l’envoi d’un message. Avant, `git add -A` puis `git reset` désindexait
tout à chaque message. Bon candidat pour une PR upstream (un seul fichier).

Même principe pour le **rollback** ↶ (`fix/rollback-keep-index`) : `rollbackToSnapshot` restaure les fichiers
via un index temporaire (`git checkout <sha> -- .` avec `GIT_INDEX_FILE`), supprime les fichiers créés depuis
le snapshot (suivis ou non, sauf `node_modules` et `.env`, et les dossiers vidés), puis ne retire de l'index
réel que les fichiers **ajoutés** qui n'existent plus (un fichier présent dans `HEAD` garde son entrée,
sinon sa suppression non stagée deviendrait stagée). Le staging d'avant le message est donc conservé.
Le helper `withTempIndex` (`server/agent/git-index.ts`) sert au snapshot, au rollback et au diff par tour.
Le SHA reçu est validé (hexadécimal) et plus jamais interpolé dans une commande shell.

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

### 5. `/clear` et `/resume` — `feat/session-cmds`

- `/clear` : met `claudeSessionId` à `null` et le sauvegarde : le prochain message démarre une session
  Claude vierge. La conversation affichée est **conservée** à l’écran (rien n’est supprimé en base),
  mais l’agent ne la voit plus.
- `/resume` : liste les 10 dernières sessions du projet (`~/.claude/projects/<chemin-encodé>/*.jsonl`,
  titre généré par le CLI, sinon premier message ; dossier = chemin du projet avec tout caractère
  non alphanumérique remplacé par `-`). `/resume <n>` ou `/resume <début d’id>` met cet identifiant
  dans `claudeSessionId` : le prochain message passe `--resume <id>` au CLI.
- Limite : l’historique de la session reprise **n’est pas affiché** dans le chat, seul l’agent le retrouve.
- Les deux sont refusés (409) tant que l’agent tourne.
- Fichiers : `server/agent/claude-sessions.ts` (nouveau, lit seulement les 256 premiers Ko de chaque
  fichier), routes `GET /api/agent/claude-sessions`, `POST /api/agent/clear`, `POST /api/agent/resume`
  dans `server/index.ts`, commandes dans `ChatTab.tsx`.

### 6. `/plan` — `feat/plan-mode`

`/plan` bascule le mode plan de la conversation (`/plan on` / `/plan off` pour forcer). Les messages
suivants lancent le CLI avec `--permission-mode plan` : l'agent lit le projet mais ne modifie rien et
présente un plan. Badge `PLAN` dans l'en-tête tant que le mode est actif.

- État : `planMode` sur `AgentSession` (en mémoire, **non persisté** : perdu au redémarrage du backend,
  propre à chaque conversation / sous-conversation). Pas de 409 : il s'applique au message suivant,
  y compris ceux de la file d'attente.
- Routes : `GET` et `POST /api/agent/plan` (`projectId`, `channel`, `enabled`).
- Vérifié avec le vrai CLI : aucun fichier créé, le plan est présenté. Le CLI écrit aussi son plan dans
  `~/.claude/plans/` (hors du projet).
- `ExitPlanMode` n'existe pas en headless : pour exécuter le plan, faire `/plan off` puis le demander.
- Fichiers : `server/agent/send-message.ts` (flag), `types.ts`, `server/index.ts`, `ChatTab.tsx`.

### 7. Worktrees — `feat/worktrees`

Une branche (sous-conversation) peut tourner dans son **propre git worktree** : dossier et branche git
dédiés, donc deux agents en parallèle sur un même dépôt ne se marchent plus dessus (fichiers, snapshots,
diffs, undo).

- **Création** : en cliquant sur l'icône ⎇ d'un message, une boîte propose « Isoler dans un worktree »
  (choix mémorisé) et le nom. Dossier : `~/.overlord/worktrees/<projet>-<id>/<nom>-<id>`, branche
  `overlord/<nom>-<id>`, créée depuis le HEAD du projet. Hors de tout dépôt, pour ne pas polluer le
  `git add -A` des snapshots.
- **Préparation** : lien symbolique `node_modules` ; copie des `.env*` de la racine **seulement s'ils
  sont ignorés par git** (sinon ils apparaîtraient comme modifiés). `/node_modules` est ajouté à
  `.git/info/exclude` (local, partagé par les worktrees) : un lien symbolique n'est pas couvert par un
  motif `node_modules/` et irait sinon dans les snapshots.
- **Chemin** : `session.projectPath` pointe vers le worktree (`loadSessionFromDb`, `resolveProjectPath`
  dans `server/agent/sessions.ts`). Le serveur le décide depuis la base, jamais le client. Un worktree
  supprimé à la main n'est **pas** remplacé par le dossier du projet : l'envoi échoue avec un message.
- **Routes** `diff`, `revert`, `branch`, `claude-sessions`, `resume`, `clear` acceptent `channel`.
  `isAgentRunning` est **par dossier** : un agent dans un worktree ne bloque pas le dépôt principal.
- **`/worktree`** (dans une branche) : chemin, branche, état. `/worktree -d` supprime le worktree en
  gardant la conversation, qui travaille alors dans le dossier du projet avec une session Claude
  vierge ; `-d --force` supprime même avec du travail non sauvegardé.
- **Suppression** d'une branche ou d'un projet : le worktree n'est retiré que s'il est propre et sans
  commit non fusionné ; sinon il reste sur disque, avec son chemin affiché (bandeau dans l'onglet
  Conversations). L'onglet affiche `⎇ overlord/…` avec `n~` fichiers modifiés et `n↑` commits en avance.
- **Récupérer le travail** : `/merge` (voir section 9) fait tout ça depuis Overlord. À la main :
  1. commiter dans le worktree (demander à l'agent « commite », ou `git add -A && git commit` dans le dossier
     donné par `/worktree`) : sans commit, rien n'est sauvegardé dans la branche git ;
  2. depuis le **dépôt principal** : `git switch main && git merge overlord/<nom>`, ou pousser la branche et
     ouvrir une PR (`git push -u origin overlord/<nom>` puis `gh pr create`) ;
  3. `/worktree -d` dans la branche : supprime le dossier et la branche git une fois fusionnée.
  Pièges : deux branches qui touchent le même fichier donnent un conflit à la seconde fusion ; des
  modifications non commitées dans le dépôt principal peuvent bloquer le `git merge` ; après un
  `git merge --squash`, git juge la branche non fusionnée, donc `/worktree -d --force` est nécessaire.
- Fichiers : `server/agent/git-worktree.ts` (nouveau), colonnes `worktree_path` / `worktree_branch`
  (`conversations`), `server/routes/conversations.ts`, `server/index.ts` (`pathFor`),
  `src/components/NewBranchDialog.tsx` (nouveau), `ConversationsTab.tsx`, `SubConversationModal.tsx`.

### 8. Corrections de la saisie — `fix/slash-enter-caret`

- Entrée sur une commande `/` **déjà tapée en entier** (`/plan`) l'envoie ; avant, elle ne faisait que
  l'autocompléter (`/plan ` avec un espace), ce qui obligeait à un second Entrée. Tab complète toujours,
  et Entrée complète la commande surlignée quand ce qui est tapé n'est qu'un début (`/pl`).
- `RichPasteInput` reconstruit son contenu quand la valeur change de l'extérieur et perdait le curseur
  (il sautait avant le `/`). Il est maintenant replacé à la fin, seulement si l'éditeur a le focus.
- Fichiers : `src/components/ChatTab.tsx` (`handleKeyDown`), `src/components/RichPasteInput.tsx`.

### 9. `/merge` — `feat/merge-cmd`

Dans une branche avec worktree : `/merge` ramène le travail sur la branche de base, `/merge --pr` ouvre
une PR. À **relancer** jusqu'à la fin : chaque appel fait ce qu'il peut et s'arrête à l'étape qui a
besoin de l'agent (`POST /api/conversations/:id/merge`, réponse avec `step`).

1. Modifications non commitées (ou fusion résolue mais pas commitée) → `commit_needed` : l'agent de la
   branche reçoit la consigne de commiter avec un message clair.
2. La branche de base est fusionnée **dans le worktree** (`git merge`) : en cas de conflit → `conflicts`,
   l'état reste dans le worktree et l'agent reçoit la consigne de les résoudre. La base ne reçoit donc
   jamais de fusion en conflit.
3. `/merge` : `git merge --ff-only` dans le dossier principal (qui doit être sur la branche de base, sinon
   message explicite), puis le worktree et la branche `overlord/…` sont supprimés (`merged`). La
   conversation continue dans le dossier principal, avec une session Claude vierge.
4. `/merge --pr` : mise à jour depuis `origin/<base>` (fetch best-effort), `git push -u origin
   overlord/<nom>`, puis `gh pr create --repo <dépôt> --base <base> --head overlord/<nom> --fill`.
   Rien n'est fusionné en local ; le worktree est conservé. Si la PR existe déjà, son URL est renvoyée.

- **Dépôt cible** : calculé depuis le `origin` **du projet** (`git remote get-url origin` → `owner/repo`) et
  passé explicitement à `--repo` : `gh` ne devine jamais (sur un fork il viserait l'upstream, et chaque
  projet Overlord a son propre remote). Uniquement GitHub (`github.com`, ssh ou https), avec `gh` installé
  et connecté ; sinon message clair, et la branche est quand même poussée si l'échec vient de `gh`.
- La branche de base est celle du dossier principal **à la création du worktree** (colonne
  `worktree_base`).
- Refusé (409) tant que l'agent tourne dans le worktree.
- Fichiers : `server/agent/git-merge.ts` (nouveau), `server/routes/conversations.ts` (route + helper
  `detachWorktree` partagé avec `/worktree -d`), `ChatTab.tsx` (`/merge`, `sendPrompt`).
- Testé sur dépôts jetables : cas heureux, base qui avance, conflit puis résolution, dossier principal sur
  une autre branche, push vers un dépôt nu et PR avec un faux `gh`. **La création réelle d'une PR n'a pas
  été testée** (à essayer une fois sur un dépôt GitHub jetable).

## Limites connues

- `/merge` : le badge `worktree · …` de la fenêtre de la branche ne se met à jour qu'à sa réouverture ;
  la liste des branches de l'onglet Conversations se rafraîchit au prochain chargement.
- Worktrees : pas de CodeGraph (l'index est par chemin) ; `node_modules` partagé (deux branches qui
  changent des dépendances se gênent) ; création uniquement au moment où la
  branche est créée (pas d'ajout a posteriori) ; une branche git ne peut être extraite qu'à un seul
  endroit (`/branch <nom>` sur une branche déjà utilisée ailleurs renvoie l'erreur de git).
- Diff d'un tour passé : après un undo de fichier ou de tour, le diff affiché ne change pas (deux snapshots
  fixes) ; seul l'undo par bloc l'indique (`✓ Undone`), pas encore l'undo de fichier ou de tour.
- Rollback : ce que vous avez stagé **après** le snapshot reste stagé (le fichier revient à l'état du
  snapshot mais garde sa version stagée, donc `MM`) ; `git restore --staged <fichier>` pour l'enlever.

## Feuille de route

| Ordre | Changement | Branche |
|---|---|---|
| 3 ✅ | Snapshot qui préserve le staging | `fix/snapshot-keep-index` |
| 4 ✅ | `/branch` + branche courante dans l’en-tête | `feat/branch-cmd` |
| 5 ✅ | `/clear` et `/resume` | `feat/session-cmds` |
| 6 ✅ | `/plan` (`--permission-mode plan`) | `feat/plan-mode` |
| 7 ✅ | Worktrees : deux tâches en parallèle sur un même repo | `feat/worktrees` |
| 8 ✅ | `/merge` : commit + fusion + nettoyage d'un worktree, ou PR, depuis Overlord | `feat/merge-cmd` |
| 10 ✅ | Annulation par bloc (hunk) dans la fenêtre de diff | `feat/hunk-undo` |
| 9 ✅ | Index temporaire aussi dans `rollbackToSnapshot` | `fix/rollback-keep-index` |

## Repères pour développer

- Routes agent : `server/index.ts`, à côté de `/api/agent/rollback`.
- Session agent : `server/agent/types.ts` (`AgentSession`, `Channel`), `server/agent/sessions.ts`.
- Lancement du CLI : `server/agent/send-message.ts`.
- Thème : toujours sombre (`<html class="dark">` dans `index.html`).
- Vérifier avant de committer : `npx tsc --noEmit -p .` puis `npx vite build`.
- Données locales : base SQLite `~/.overlord/overlord.db`, worktrees `~/.overlord/worktrees/`.
- Tester la logique serveur sans toucher à ces données : script `tsx` (Node 22) lancé avec un `HOME`
  temporaire (`HOME=$(mktemp -d) npx tsx test.mts`), qui appelle les modules (`git-worktree.ts`…) ou
  les routes Hono en mémoire (`app.request("/sub", …)`) sur un dépôt git jetable. Un script placé hors du
  projet doit importer `drizzle-orm` par son chemin absolu.
- Tester l'interface (worktrees) : projet jetable hors du Bureau, deux branches avec worktree lancées en
  même temps sur le même fichier, vérifier que les diffs restent séparés et que le dépôt principal est
  intact, puis supprimer une branche propre (dossier retiré) et une branche modifiée (dossier conservé).

## Pièges rencontrés

- macOS peut refuser l’accès à `~/Desktop` au processus `claude` (`Operation not permitted`) même
  quand le terminal y accède. Remède : `tccutil reset SystemPolicyDesktopFolder`, redémarrer, ou
  garder les projets hors du Bureau (par exemple `~/Developer`).
- Une PR se crée sur le fork avec `gh pr create --repo DonDes17/overlord --base main --head <branche>`
  (sans `--repo`, `gh` vise `poptocrack/overlord`). Fixer une fois : `gh repo set-default DonDes17/overlord`.
- `gh pr create --fill` échoue sans `origin/main` en local : faire `git fetch origin` avant.
- Un test qui crée des worktrees ou une base doit se faire avec un `HOME` temporaire, sinon il écrit dans
  le vrai `~/.overlord`.
- `/branch <nom>` ne crée plus rien tout seul (`/branch -c <nom>`) : avec la création implicite, une faute
  de frappe sur un nom de branche créait une branche par erreur (cas vécu avec `main` absent d'un projet).
